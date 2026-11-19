import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../auth.ts';
import type { Db } from '../db.ts';
import { redactAi } from '../domain/ai-redact.ts';

/**
 * «Assistente AI» (module ai_assistant): the AIs work on the PCs with Continuity; an agent next to
 * it connects OUT to this server with its own token and forwards only the permission requests of
 * the AI. An admin allows or denies them from the console or the app. The server never commands
 * the PC: it can only answer yes or no to a request the agent itself created, and a request the PC
 * marks «local only» (git push, credentials, network devices...) cannot be allowed from here.
 */
export const AGENT_PREFIX = 'cdaagt_';
export const AGENT_MAX_DAYS = 90;
export const AGENT_MAX_ACTIVE = 5;
/** A request nobody answers within this time counts as denied. */
export const REQUEST_TTL_MS = 10 * 60_000;
export const REQUEST_RETENTION_DAYS = 30;
const MAX_PENDING_PER_AGENT = 20;
const DETAIL_MAX = 1500;
const MAX_SESSIONS = 20;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clean = (s: unknown, max: number) => redactAi(String(s ?? ''), max).replace(/\s+/g, ' ').trim();

export interface AgentAuth {
  id: number;
  name: string;
  userId: number;
}

export interface AiSession {
  ref: string;
  goal: string;
  ai: string;
  state: string;
  project: string;
}

export interface AiRequestView {
  id: number;
  agentId: number;
  agent: string;
  owner: string;
  ownerId: number;
  ref: string;
  sessionRef: string;
  ai: string;
  tool: string;
  detail: string;
  localOnly: boolean;
  state: 'pending' | 'allowed' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface RequestRow {
  id: number;
  agent_id: number;
  agent: string;
  owner: string;
  owner_id: number;
  ref: string;
  session_ref: string;
  ai: string;
  tool: string;
  detail: string;
  local_only: number;
  state: AiRequestView['state'];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
}

const SELECT_REQUEST = `SELECT r.*, a.name agent, a.user_id owner_id, u.username owner, d.username decided_by_name
  FROM ai_permission_requests r JOIN ai_agents a ON a.id = r.agent_id JOIN users u ON u.id = a.user_id LEFT JOIN users d ON d.id = r.decided_by`;

const view = (r: RequestRow): AiRequestView => ({
  id: r.id,
  agentId: r.agent_id,
  agent: r.agent,
  owner: r.owner,
  ownerId: r.owner_id,
  ref: r.ref,
  sessionRef: r.session_ref,
  ai: r.ai,
  tool: r.tool,
  detail: r.detail,
  localOnly: !!r.local_only,
  state: r.state,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by_name,
});

export function createAiAssistant(
  db: Db,
  deps: {
    /** A notice to the owner of the agent (Notifiche, push, personal Telegram): never the command. */
    notice: (userId: number, title: string, lines: string[]) => void;
    /** Something changed for the consoles (live update). */
    changed: () => void;
    now?: () => number;
  },
) {
  const now = deps.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const waiters = new Map<number, Set<() => void>>();
  let timers: ReturnType<typeof setInterval>[] = [];

  function wake(agentId: number) {
    const set = waiters.get(agentId);
    if (!set) return;
    waiters.delete(agentId);
    for (const w of set) w();
  }

  function createAgent(o: { userId: number; tokenVersion: number; name: string; days: number; ip: string }) {
    const active = (db.prepare('SELECT COUNT(*) n FROM ai_agents WHERE revoked_at IS NULL AND expires_at > ?').get(iso(now())) as { n: number }).n;
    if (active >= AGENT_MAX_ACTIVE) throw new HttpError(409, 'too_many_agents');
    const token = `${AGENT_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = iso(now() + Math.min(Math.max(1, Math.trunc(o.days)), AGENT_MAX_DAYS) * 86_400_000);
    const name = o.name.replace(/[\u0000-\u001f]/g, '').trim();
    const r = db
      .prepare('INSERT INTO ai_agents(name, user_id, token_version, token_hash, created_at, created_ip, expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(name, o.userId, o.tokenVersion, sha(token), iso(now()), o.ip, expiresAt);
    return { id: Number(r.lastInsertRowid), name, token, expiresAt };
  }

  function listAgents() {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, u.username owner, a.user_id ownerId, a.created_at createdAt, a.expires_at expiresAt, a.revoked_at revokedAt,
                a.last_seen_at lastSeenAt, a.agent_version version, a.sessions,
                (SELECT COUNT(*) FROM ai_permission_requests r WHERE r.agent_id = a.id AND r.state = 'pending') pending
           FROM ai_agents a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 50`,
      )
      .all() as Array<{ id: number; name: string; owner: string; ownerId: number; createdAt: string; expiresAt: string; revokedAt: string | null; lastSeenAt: string | null; version: string; sessions: string; pending: number }>;
    const t = iso(now());
    return rows.map(({ sessions, ...a }) => {
      let s: AiSession[] = [];
      try {
        s = JSON.parse(sessions) as AiSession[];
      } catch {}
      return { ...a, active: !a.revokedAt && a.expiresAt > t, sessions: s };
    });
  }

  function revokeAgent(id: number, by: number): { name: string; userId: number } | null {
    const a = db.prepare('SELECT name, user_id userId FROM ai_agents WHERE id = ? AND revoked_at IS NULL').get(id) as { name: string; userId: number } | undefined;
    if (!a) return null;
    db.prepare('UPDATE ai_agents SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(iso(now()), by, id);
    db.prepare("UPDATE ai_permission_requests SET state = 'expired', decided_at = ? WHERE agent_id = ? AND state = 'pending'").run(iso(now()), id);
    wake(id);
    deps.changed();
    return a;
  }

  /**
   * The agent's token: valid while not revoked nor expired and while its admin is still an active
   * admin with the same password (token_version) and the second step on, like the MCP connections.
   */
  function authenticate(token: string): AgentAuth | null {
    if (!token.startsWith(AGENT_PREFIX) || token.length > 120) return null;
    const a = db
      .prepare(
        `SELECT a.id, a.name, a.user_id userId, a.token_version tv, a.expires_at expiresAt, a.revoked_at revokedAt,
                u.active, u.role, u.token_version utv, u.totp_enabled totp
           FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE a.token_hash = ?`,
      )
      .get(sha(token)) as
      | { id: number; name: string; userId: number; tv: number; expiresAt: string; revokedAt: string | null; active: number; role: string; utv: number; totp: number }
      | undefined;
    if (!a || a.revokedAt || a.expiresAt <= iso(now())) return null;
    if (!a.active || a.role !== 'admin' || a.utv !== a.tv || !a.totp) return null;
    return { id: a.id, name: a.name, userId: a.userId };
  }

  function hello(agent: AgentAuth, o: { version: string; sessions: AiSession[]; ip: string }) {
    const sessions = o.sessions.slice(0, MAX_SESSIONS).map((s) => ({
      ref: clean(s.ref, 80),
      goal: clean(s.goal, 120),
      ai: clean(s.ai, 40),
      state: clean(s.state, 30),
      project: clean(s.project, 60),
    }));
    db.prepare('UPDATE ai_agents SET last_seen_at = ?, last_ip = ?, agent_version = ?, sessions = ? WHERE id = ?').run(iso(now()), o.ip, clean(o.version, 40), JSON.stringify(sessions), agent.id);
    deps.changed();
  }

  function getRequest(id: number): AiRequestView | null {
    const r = db.prepare(`${SELECT_REQUEST} WHERE r.id = ?`).get(id) as RequestRow | undefined;
    return r ? view(r) : null;
  }

  function submit(agent: AgentAuth, o: { ref: string; sessionRef: string; ai: string; tool: string; detail: string; localOnly: boolean }): AiRequestView {
    const ref = clean(o.ref, 80);
    const old = db.prepare('SELECT id FROM ai_permission_requests WHERE agent_id = ? AND ref = ?').get(agent.id, ref) as { id: number } | undefined;
    if (old) return getRequest(old.id)!;
    const pending = (db.prepare("SELECT COUNT(*) n FROM ai_permission_requests WHERE agent_id = ? AND state = 'pending'").get(agent.id) as { n: number }).n;
    if (pending >= MAX_PENDING_PER_AGENT) throw new HttpError(429, 'too_many_pending');
    const tool = clean(o.tool, 120) || 'strumento';
    const ai = clean(o.ai, 40);
    const r = db
      .prepare('INSERT INTO ai_permission_requests(agent_id, ref, session_ref, ai, tool, detail, local_only, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(agent.id, ref, clean(o.sessionRef, 80), ai, tool, redactAi(o.detail, DETAIL_MAX), o.localOnly ? 1 : 0, iso(now()), iso(now() + REQUEST_TTL_MS));
    const lines = [`${ai || 'L’AI'} vuole usare: ${tool}`, o.localOnly ? 'Si decide solo sul PC, davanti allo schermo.' : 'Apri Assistente AI per consentire o negare (scade tra 10 minuti).'];
    deps.notice(agent.userId, `🤖 ${agent.name} chiede un permesso`, lines);
    deps.changed();
    return getRequest(Number(r.lastInsertRowid))!;
  }

  /** The answers not yet given to the agent; each one is handed over once. */
  function takeDecisions(agentId: number) {
    const rows = db
      .prepare("SELECT id, ref, state FROM ai_permission_requests WHERE agent_id = ? AND state <> 'pending' AND delivered_at IS NULL ORDER BY id LIMIT 50")
      .all(agentId) as Array<{ id: number; ref: string; state: string }>;
    if (rows.length) {
      const mark = db.prepare('UPDATE ai_permission_requests SET delivered_at = ? WHERE id = ?');
      for (const r of rows) mark.run(iso(now()), r.id);
    }
    return rows.map((r) => ({ ref: r.ref, allow: r.state === 'allowed', state: r.state }));
  }

  /** Long poll: the answers as soon as there are some, at most [waitMs] later (empty list). */
  function waitDecisions(agentId: number, waitMs: number): Promise<ReturnType<typeof takeDecisions>> {
    const ready = takeDecisions(agentId);
    if (ready.length || waitMs <= 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.get(agentId)?.delete(finish);
        resolve(takeDecisions(agentId));
      };
      const timer = setTimeout(finish, waitMs);
      const set = waiters.get(agentId) ?? new Set();
      set.add(finish);
      waiters.set(agentId, set);
    });
  }

  function listRequests(o: { state?: AiRequestView['state'] | undefined; limit?: number }) {
    expire();
    const rows = (
      o.state
        ? db.prepare(`${SELECT_REQUEST} WHERE r.state = ? ORDER BY r.id DESC LIMIT ?`).all(o.state, o.limit ?? 100)
        : db.prepare(`${SELECT_REQUEST} ORDER BY r.id DESC LIMIT ?`).all(o.limit ?? 100)
    ) as unknown as RequestRow[];
    return rows.map(view);
  }

  /** Only the admin who owns the agent decides; a «local only» request can only be denied here. */
  function decide(id: number, userId: number, allow: boolean): AiRequestView {
    expire();
    const r = getRequest(id);
    if (!r) throw new HttpError(404, 'request_not_found');
    if (r.ownerId !== userId) throw new HttpError(403, 'not_agent_owner');
    if (r.state !== 'pending') throw new HttpError(409, 'already_decided', { state: r.state });
    if (allow && r.localOnly) throw new HttpError(409, 'local_only');
    const changed = db
      .prepare("UPDATE ai_permission_requests SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'")
      .run(allow ? 'allowed' : 'denied', iso(now()), userId, id).changes;
    if (!changed) throw new HttpError(409, 'already_decided');
    wake(r.agentId);
    deps.changed();
    return getRequest(id)!;
  }

  /** Unanswered requests past their time count as denied. */
  function expire() {
    const rows = db.prepare("SELECT DISTINCT agent_id id FROM ai_permission_requests WHERE state = 'pending' AND expires_at <= ?").all(iso(now())) as Array<{ id: number }>;
    if (!rows.length) return 0;
    const n = db.prepare("UPDATE ai_permission_requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ?").run(iso(now()), iso(now())).changes;
    for (const r of rows) wake(r.id);
    deps.changed();
    return Number(n);
  }

  /** Requests are kept 30 days (the decisions stay in the activity log without the command). */
  function sweep() {
    return Number(db.prepare('DELETE FROM ai_permission_requests WHERE created_at < ?').run(iso(now() - REQUEST_RETENTION_DAYS * 86_400_000)).changes);
  }

  return {
    createAgent,
    listAgents,
    revokeAgent,
    authenticate,
    hello,
    submit,
    getRequest,
    takeDecisions,
    waitDecisions,
    listRequests,
    decide,
    expire,
    sweep,
    start() {
      timers.push(setInterval(() => expire(), 15_000));
      timers.push(setInterval(() => sweep(), 3_600_000));
      for (const t of timers) t.unref?.();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      for (const id of [...waiters.keys()]) wake(id);
    },
  };
}
export type AiAssistant = ReturnType<typeof createAiAssistant>;

