import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/** «Conoscenza AI» (module ai_memory): who sees everything reads, the admins refresh. */
export function aiMemoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const on = ctx.modules.require('ai_memory');
  const reader = { preHandler: [ctx.auth.requireSeesAll, on] };
  const admin = { preHandler: [ctx.auth.requireAdmin, on] };
  const m = ctx.aiMemory;

  app.get('/api/admin/ai/memory', reader, async () => ({ state: m.state(), files: m.list() }));

  app.get('/api/admin/ai/memory/file', reader, async (req) => {
    const path = z.string().min(1).max(300).parse((req.query as { path?: string }).path);
    const f = m.read(path);
    if (!f) throw new HttpError(404, 'memory_file_not_found');
    return f;
  });

  app.post('/api/admin/ai/memory/refresh', admin, async (req) => {
    const s = await m.refresh(true);
    recordEvent(ctx.db, req.user!.id, 'ai.memory.refresh', s.commit?.slice(0, 7) ?? '', s.ok ? `${s.count} file, ${s.skipped.length} scartati` : `errore: ${s.error ?? ''}`);
    return { state: s, files: m.list() };
  });

  /** The GitHub token from the console (servers without SSH): admins, with a fresh second-step code. */
  app.put('/api/admin/ai/memory/token', { ...admin, bodyLimit: 4 * 1024 }, async (req) => {
    const b = z.object({ token: z.string().trim().max(300), code: z.string().trim().max(12) }).strict().parse(req.body ?? {});
    const u = ctx.freshCode.check(req.user!.id, b.code);
    try {
      await m.setToken(b.token, u.username);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'env') throw new HttpError(409, 'hub_token_in_env');
      if (msg === 'format') throw new HttpError(400, 'hub_token_format');
      // GitHub's answer, never the token (the messages are written in ai-memory.ts)
      throw new HttpError(400, 'hub_token_rejected', { detail: msg.slice(0, 200) });
    }
    recordEvent(ctx.db, req.user!.id, 'ai.memory.token', 'console', 'token GitHub inserito');
    const s = await m.refresh(true);
    return { state: s, files: m.list() };
  });

  app.delete('/api/admin/ai/memory/token', admin, async (req) => {
    try {
      if (m.clearToken(req.user!.username)) recordEvent(ctx.db, req.user!.id, 'ai.memory.token', 'console', 'token GitHub tolto');
    } catch {
      throw new HttpError(409, 'hub_token_in_env');
    }
    return { state: m.state(), files: m.list() };
  });
}
