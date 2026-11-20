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
}
