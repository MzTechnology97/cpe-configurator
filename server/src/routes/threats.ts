import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { ASSET_KINDS, MAX_INDICATORS } from '../services/threats.ts';

const list = z.array(z.string().max(320)).max(MAX_INDICATORS).default([]);
const asset = z
  .object({
    name: z.string().trim().min(2).max(120),
    kind: z.enum(ASSET_KINDS),
    searchName: z.boolean().optional(),
    domains: list,
    ips: list,
    emails: list,
    notes: z.string().max(1000).optional(),
  })
  .strict();

/**
 * «Minacce» (module threats, admins only: security data of the NIS2 perimeter): the asset cards,
 * the hits from ransomware.live, the check on demand and the password check (never stored).
 */
export function threatsRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('threats')] };
  const { db } = ctx;
  const fail = (e: unknown): never => {
    const err = e as Error & { status?: number; detail?: unknown };
    if (err instanceof HttpError) throw err;
    throw new HttpError(err.status ?? 502, err.message, err.detail !== undefined ? { detail: err.detail } : undefined);
  };
  const idOf = (p: unknown) => z.coerce.number().int().positive().parse((p as { id: string }).id);

  app.get('/api/admin/threats', admin, async () => ({
    configured: ctx.threats.configured(),
    status: ctx.threats.status(),
    assets: ctx.threats.assets(),
    hits: ctx.threats.hits(),
    passwordChecks: ctx.threats.passwordChecks(),
  }));

  app.post('/api/admin/threats/assets', admin, async (req) => {
    const b = asset.parse(req.body);
    try {
      const a = ctx.threats.addAsset(b, req.user!.id);
      recordEvent(db, req.user!.id, 'threats.asset', a.name, 'scheda asset creata');
      return a;
    } catch (e) {
      return fail(e);
    }
  });

  app.put('/api/admin/threats/assets/:id', admin, async (req) => {
    const id = idOf(req.params);
    const b = asset.parse(req.body);
    let a;
    try {
      a = ctx.threats.updateAsset(id, b, req.user!.id);
    } catch (e) {
      return fail(e);
    }
    if (!a) throw new HttpError(404, 'asset_not_found');
    recordEvent(db, req.user!.id, 'threats.asset', a.name, 'scheda asset modificata');
    return a;
  });

  app.delete('/api/admin/threats/assets/:id', admin, async (req) => {
    const id = idOf(req.params);
    if (!ctx.threats.removeAsset(id)) throw new HttpError(404, 'asset_not_found');
    recordEvent(db, req.user!.id, 'threats.asset', String(id), 'scheda asset eliminata');
    return { ok: true };
  });

  app.post('/api/admin/threats/check', admin, async (req) => {
    if (!ctx.threats.configured()) throw new HttpError(409, 'ransomware_live_key_missing');
    recordEvent(db, req.user!.id, 'threats.check', '', '');
    return ctx.threats.refresh();
  });

  /**
   * The password is checked and forgotten: never logged, never stored, never sent whole (only the
   * first 5 characters of its SHA-1). The activity log keeps the label and the result.
   */
  app.post('/api/admin/threats/assets/:id/password', admin, async (req) => {
    const id = idOf(req.params);
    const b = z.object({ label: z.string().trim().min(1).max(80), password: z.string().min(1).max(256) }).strict().parse(req.body);
    try {
      const r = await ctx.threats.checkPassword(id, b.label, b.password);
      recordEvent(db, req.user!.id, 'threats.password', b.label, r.seen ? `trovata ${r.seen} volte nelle liste rubate` : 'non trovata nelle liste rubate');
      return r;
    } catch (e) {
      return fail(e);
    }
  });
}
