import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { SITE_STATUSES } from '../services/operator-sites.ts';

const site = z
  .object({
    operator: z.string().trim().min(2).max(40),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    status: z.enum(SITE_STATUSES),
    note: z.string().max(500).optional(),
    radios: z.array(z.string().max(8)).max(5).optional(),
  })
  .strict();

const view = z.object({
  south: z.coerce.number().min(-90).max(90),
  west: z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180),
  operators: z.string().max(400).optional(),
});

/**
 * «Antenne altri operatori» (module operator_sites): the map for the staff, the import from
 * OpenCelliD and the sites added by hand for the admins.
 */
export function operatorSitesRoutes(app: FastifyInstance, ctx: AppContext) {
  const staff = { preHandler: [ctx.auth.requireStaff, ctx.modules.require('operator_sites')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('operator_sites')] };
  const s = ctx.operatorSites;
  const { db } = ctx;
  const idOf = (p: unknown) => z.coerce.number().int().positive().parse((p as { id: string }).id);
  const fail = (e: unknown): never => {
    const err = e as Error & { status?: number };
    if (err instanceof HttpError) throw err;
    throw new HttpError(err.status ?? 500, err.message);
  };

  app.get('/api/operator-sites', staff, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const v = q.south !== undefined ? view.parse(q) : null;
    const ops = q.operators ? q.operators.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : null;
    const r = s.list(v ? { south: v.south, west: v.west, north: v.north, east: v.east } : null, ops);
    return { ...r, summary: s.summary(), status: s.status(), configured: s.configured(), running: s.running(), settings: s.settings() };
  });

  app.get('/api/admin/operator-sites/manual', admin, async () => ({ items: s.manual() }));

  app.post('/api/admin/operator-sites', admin, async (req) => {
    const b = site.parse(req.body);
    try {
      const x = s.addManual(b, req.user!.id);
      recordEvent(db, req.user!.id, 'operator_sites.add', x.operator, `${x.lat}, ${x.lon} · ${x.status}`);
      return x;
    } catch (e) {
      return fail(e);
    }
  });

  app.put('/api/admin/operator-sites/:id', admin, async (req) => {
    const id = idOf(req.params);
    const x = s.updateManual(id, site.parse(req.body), req.user!.id);
    if (!x) throw new HttpError(404, 'site_not_found');
    recordEvent(db, req.user!.id, 'operator_sites.edit', x.operator, `${x.lat}, ${x.lon} · ${x.status}`);
    return x;
  });

  app.delete('/api/admin/operator-sites/:id', admin, async (req) => {
    const id = idOf(req.params);
    if (!s.removeManual(id)) throw new HttpError(404, 'site_not_found');
    recordEvent(db, req.user!.id, 'operator_sites.delete', String(id), '');
    return { ok: true };
  });

  /** The import now: it takes a few minutes, so it starts and the page follows it (running, then status). */
  app.post('/api/admin/operator-sites/import', admin, async (req) => {
    if (!s.configured()) throw new HttpError(409, 'opencellid_token_missing');
    recordEvent(db, req.user!.id, 'operator_sites.import', '', '');
    void s.refresh();
    return { started: true };
  });
}
