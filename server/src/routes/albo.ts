import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { MAX_SOURCES } from '../services/albo.ts';

const kind = z.enum(['albo', 'bandi']);
const url = z.string().trim().min(8).max(500);

/**
 * «Albo e permessi» (module albo): the acts on networks and the calls for tenders of the chosen
 * municipalities. Data of CDA Net: who sees everything reads them, only admins change the lists.
 */
export function alboRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = { preHandler: [ctx.auth.requireSeesAll, ctx.modules.require('albo')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('albo')] };
  const { db } = ctx;
  const fail = (e: unknown): never => {
    const err = e as Error & { status?: number };
    throw new HttpError(err.status ?? 502, err.message);
  };

  app.get('/api/admin/albo', staff, async (req) => {
    const q = z.object({ comune: z.string().trim().max(120).optional(), kind: kind.optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return { config: ctx.albo.config(), states: ctx.albo.states(), status: ctx.albo.status(), items: ctx.albo.items(q) };
  });

  app.put('/api/admin/albo/config', admin, async (req) => {
    const b = z
      .object({
        sources: z
          .array(z.object({ id: z.string().max(40).optional(), comune: z.string().trim().min(2).max(120), kind, url, paused: z.boolean().optional() }).strict())
          .max(MAX_SOURCES),
        keywords: z.object({ albo: z.array(z.string().max(80)).max(200), bandi: z.array(z.string().max(80)).max(200) }).strict(),
      })
      .strict()
      .parse(req.body);
    let next;
    try {
      next = ctx.albo.setConfig(b, req.user!.id);
    } catch (e) {
      return fail(e);
    }
    recordEvent(db, req.user!.id, 'albo.config', `${next.sources.length} elenchi`, [...new Set(next.sources.map((s) => s.comune))].join(', '));
    return next;
  });

  app.post('/api/admin/albo/preview', admin, async (req) => {
    const b = z.object({ url, kind }).strict().parse(req.body);
    try {
      return await ctx.albo.preview(b.url, b.kind);
    } catch (e) {
      return fail(e);
    }
  });

  app.post('/api/admin/albo/check', admin, async (req) => {
    recordEvent(db, req.user!.id, 'albo.check', '', '');
    return ctx.albo.refresh();
  });
}
