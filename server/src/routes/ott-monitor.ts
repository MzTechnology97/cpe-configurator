import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { OTT_CATEGORIES, STATUS_KINDS } from '../services/ott-monitor.ts';

const service = z
  .object({
    name: z.string().trim().min(2).max(60),
    category: z.enum(OTT_CATEGORIES),
    probeUrl: z.string().trim().max(300),
    statusKind: z.enum(STATUS_KINDS),
    statusUrl: z.string().trim().max(300).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** «Servizi OTT e CDN» (module ott_monitor): the list for the staff, the services for the admins. */
export function ottMonitorRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = { preHandler: [ctx.auth.requireStaff, ctx.modules.require('ott_monitor')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('ott_monitor')] };
  const m = ctx.ottMonitor;
  const { db } = ctx;
  const idOf = (p: unknown) => z.coerce.number().int().positive().parse((p as { id: string }).id);
  const fail = (e: unknown): never => {
    const err = e as Error & { status?: number };
    if (err instanceof HttpError) throw err;
    throw new HttpError(err.status ?? 500, err.message);
  };

  app.get('/api/ott', staff, async () => ({ services: m.list(), outage: m.outage(), lastAt: m.lastAt() }));

  app.post('/api/admin/ott', admin, async (req) => {
    try {
      const s = m.add(service.parse(req.body));
      recordEvent(db, req.user!.id, 'ott.service', s.name, 'servizio aggiunto');
      return s;
    } catch (e) {
      return fail(e);
    }
  });

  app.put('/api/admin/ott/:id', admin, async (req) => {
    const id = idOf(req.params);
    let s;
    try {
      s = m.update(id, service.parse(req.body));
    } catch (e) {
      return fail(e);
    }
    if (!s) throw new HttpError(404, 'service_not_found');
    recordEvent(db, req.user!.id, 'ott.service', s.name, 'servizio modificato');
    return s;
  });

  app.delete('/api/admin/ott/:id', admin, async (req) => {
    const id = idOf(req.params);
    if (!m.remove(id)) throw new HttpError(404, 'service_not_found');
    recordEvent(db, req.user!.id, 'ott.service', String(id), 'servizio eliminato');
    return { ok: true };
  });

  /** A round now (probes and official pages): the answer when it's done (some seconds). */
  app.post('/api/admin/ott/check', admin, async () => {
    await m.round(true);
    return { services: m.list(), outage: m.outage(), lastAt: m.lastAt() };
  });
}
