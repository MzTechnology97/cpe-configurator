import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { checkSecondFactor, type SecondFactorUser } from '../services/second-factor.ts';
import { AGENT_MAX_DAYS, type AgentAuth } from '../services/ai-assistant.ts';
import { escapeHtml } from '../services/telegram.ts';

/** Requests of an agent per minute (hello, permission requests, long polls). */
const AGENT_CALLS_PER_MINUTE = 60;
/** The longest a long poll waits for an answer. */
const MAX_WAIT_S = 25;

const ref = z.string().trim().min(1).max(80);
const session = z
  .object({ ref, goal: z.string().max(500).default(''), ai: z.string().max(60).default(''), state: z.string().max(40).default(''), project: z.string().max(200).default('') })
  .strict();
const hello = z.object({ version: z.string().max(40).default(''), sessions: z.array(session).max(50).default([]) }).strict();
const request = z
  .object({
    ref,
    sessionRef: z.string().max(80).default(''),
    ai: z.string().max(60).default(''),
    tool: z.string().trim().min(1).max(300),
    detail: z.string().max(6000).default(''),
    localOnly: z.boolean().default(false),
  })
  .strict();

type AdminRow = SecondFactorUser & { active: number; role: string; token_version: number; totp_enabled: number };

/**
 * «Assistente AI» (module ai_assistant, off by default). Two sides:
 * - /api/ai-agent/*: the agent next to Continuity on a PC, with its own token (cdaagt_…), no user session;
 * - /api/admin/ai/*: the admins (second step on). Creating an agent and allowing a request need a fresh code.
 */
export function aiAssistantRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const ai = ctx.aiAssistant;
  const moduleOn = ctx.modules.require('ai_assistant');
  const admin = { preHandler: [ctx.auth.requireAdmin, moduleOn] };
  const calls = new Map<number, number[]>();
  const userRow = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as AdminRow | undefined;

  /** The agent's token, its admin still valid, and its share of requests per minute. */
  function agentOf(req: FastifyRequest): AgentAuth {
    const m = /^Bearer (\S{1,200})$/.exec(req.headers.authorization ?? '');
    const a = m ? ai.authenticate(m[1]!) : null;
    if (!a) throw new HttpError(401, 'invalid_agent_token');
    const now = Date.now();
    const recent = (calls.get(a.id) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= AGENT_CALLS_PER_MINUTE) throw new HttpError(429, 'too_many_requests');
    calls.set(a.id, [...recent, now]);
    return a;
  }

  /** A fresh second-step code of an admin who has the second step on (anti-replay inside). */
  function freshCode(userId: number, code: unknown) {
    const u = userRow(userId);
    if (!u || !u.active || u.role !== 'admin' || !u.totp_enabled) throw new HttpError(403, 'totp_required');
    if (typeof code !== 'string' || !code.trim() || !checkSecondFactor(db, ctx.sealer, u, code.trim())) throw new HttpError(401, 'invalid_code');
    return u;
  }

  // ---- the agent on the PC
  const agentRoute = { preHandler: [moduleOn], bodyLimit: 16 * 1024 };

  app.post('/api/ai-agent/hello', agentRoute, async (req) => {
    const a = agentOf(req);
    const b = hello.parse(req.body ?? {});
    ai.hello(a, { version: b.version, sessions: b.sessions, ip: req.ip });
    return { ok: true, agent: a.name, maxWaitSeconds: MAX_WAIT_S };
  });

  app.post('/api/ai-agent/requests', agentRoute, async (req) => {
    const a = agentOf(req);
    const r = ai.submit(a, request.parse(req.body ?? {}));
    return { id: r.id, ref: r.ref, state: r.state, expiresAt: r.expiresAt };
  });

  app.get('/api/ai-agent/decisions', agentRoute, async (req, reply) => {
    const a = agentOf(req);
    const wait = z.coerce.number().int().min(0).max(MAX_WAIT_S).default(0).parse((req.query as { wait?: string }).wait);
    const decisions = await ai.waitDecisions(a.id, wait * 1000);
    reply.header('Cache-Control', 'no-store');
    return { decisions };
  });

  // ---- the admins
  app.get('/api/admin/ai/agents', admin, async () => ({ agents: ai.listAgents(), maxDays: AGENT_MAX_DAYS }));

  app.post('/api/admin/ai/agents', admin, async (req) => {
    const b = z
      .object({ name: z.string().trim().min(2).max(60), days: z.number().int().min(1).max(AGENT_MAX_DAYS).default(AGENT_MAX_DAYS), code: z.string().trim().min(6).max(12) })
      .strict()
      .parse(req.body ?? {});
    const u = freshCode(req.user!.id, b.code);
    const created = ai.createAgent({ userId: u.id, tokenVersion: u.token_version, name: b.name, days: b.days, ip: req.ip });
    recordEvent(db, u.id, 'ai.agent.create', String(created.id), `agente «${created.name}», scade ${created.expiresAt.slice(0, 10)}`);
    ctx.notify.security(`Nuovo agente «Assistente AI» «${escapeHtml(created.name)}» creato da <b>${escapeHtml(u.username)}</b>, scade il ${created.expiresAt.slice(0, 10)}.`);
    return created;
  });

  app.delete('/api/admin/ai/agents/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const a = ai.revokeAgent(id, req.user!.id);
    if (!a) throw new HttpError(404, 'agent_not_found');
    recordEvent(db, req.user!.id, 'ai.agent.revoke', String(id), `agente «${a.name}» revocato`);
    return { ok: true };
  });

  app.get('/api/admin/ai/requests', admin, async (req) => {
    const state = z.enum(['pending', 'allowed', 'denied', 'expired']).optional().parse((req.query as { state?: string }).state || undefined);
    return { requests: ai.listRequests({ state }) };
  });

  /** Deny: one tap. Allow: a fresh second-step code; never for a request the PC keeps for itself. */
  app.post('/api/admin/ai/requests/:id/decision', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ allow: z.boolean(), code: z.string().max(12).optional() }).strict().parse(req.body ?? {});
    if (b.allow) {
      const r = ai.getRequest(id);
      if (r && r.localOnly) throw new HttpError(409, 'local_only');
      freshCode(req.user!.id, b.code);
    }
    const r = ai.decide(id, req.user!.id, b.allow);
    recordEvent(db, req.user!.id, b.allow ? 'ai.request.allow' : 'ai.request.deny', String(id), `${r.agent}: ${r.tool.slice(0, 120)}`);
    return r;
  });
}
