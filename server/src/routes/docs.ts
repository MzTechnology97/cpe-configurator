import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';

export const PDF_CONTENT_TYPE = 'application/pdf';
export const MAX_DOC_BYTES = 30 * 1024 * 1024;
const MAX_DOCS = 500;

type Row = { id: number; title: string; category: string; summary: string; filename: string; size: number; sha256: string; created_at: string; updated_at: string };
const SELECT = 'SELECT id, title, category, summary, filename, size, sha256, created_at, updated_at FROM documents';
const view = (r: Row) => ({ id: r.id, title: r.title, category: r.category, summary: r.summary, filename: r.filename, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at });

const meta = z.object({
  title: z.string().trim().min(2).max(160),
  category: z.string().trim().max(80).default(''),
  summary: z.string().trim().max(2000).default(''),
});

/**
 * «Manuali e documentazione» (Carmelo 15/11/2026): manuals, datasheets and suppliers' FAQ as PDFs.
 * Uploaded by the admins, read by the staff (admins, office, specialists) after login. The files
 * stay on the server's disk (DOCS_DIR), named by their SHA-256: never in the repository, never on
 * a public address.
 */
export function docsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const dir = ctx.cfg.docsDir;
  const staff = { preHandler: [ctx.auth.requireStaff] };
  const admin = { preHandler: [ctx.auth.requireAdmin] };
  const fileOf = (sha256: string) => join(dir, `${sha256}.pdf`);
  const one = (id: number) => db.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Row | undefined;
  const idOf = (p: unknown) => z.coerce.number().int().positive().parse((p as { id: string }).id);

  app.addContentTypeParser(PDF_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_DOC_BYTES }, (_req, body, done) => done(null, body));

  app.get('/api/docs', staff, async () => ({
    items: (db.prepare(`${SELECT} ORDER BY category COLLATE NOCASE, title COLLATE NOCASE`).all() as unknown as Row[]).map(view),
  }));

  /** The PDF, opened in the browser (inline) or saved; every reading is in the activity log. */
  app.get('/api/docs/:id/file', staff, async (req, reply) => {
    const r = one(idOf(req.params));
    if (!r || !existsSync(fileOf(r.sha256))) throw new HttpError(404, 'document_not_found');
    recordEvent(db, req.user!.id, 'docs.read', r.title, '');
    const name = r.filename.replace(/[^\w.+-]/g, '_');
    return reply
      .header('Content-Type', PDF_CONTENT_TYPE)
      .header('Content-Length', String(r.size))
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(fileOf(r.sha256)));
  });

  /** Upload: the PDF as the body (application/pdf), title, category and summary in the query. */
  app.post('/api/admin/docs', { ...admin, bodyLimit: MAX_DOC_BYTES }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'document_content_type');
    if (body.length < 8 || body.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'document_not_pdf');
    const q = req.query as Record<string, string | undefined>;
    const m = meta.parse(q);
    const filename = z.string().trim().min(1).max(160).catch('documento.pdf').parse(q.name).replace(/[^\w.+-]/g, '_');
    if ((db.prepare('SELECT COUNT(*) n FROM documents').get() as { n: number }).n >= MAX_DOCS) throw new HttpError(400, 'too_many_documents');
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (db.prepare('SELECT 1 FROM documents WHERE sha256 = ?').get(sha256)) throw new HttpError(409, 'document_exists');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileOf(sha256), body);
    const now = nowIso();
    const id = Number(
      db.prepare('INSERT INTO documents(title, category, summary, filename, size, sha256, created_at, created_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(m.title, m.category, m.summary, filename.endsWith('.pdf') ? filename : `${filename}.pdf`, body.length, sha256, now, req.user!.id, now).lastInsertRowid,
    );
    recordEvent(db, req.user!.id, 'docs.upload', m.title, `${filename} · ${body.length} byte`);
    reply.code(201);
    return { item: view(one(id)!) };
  });

  app.put('/api/admin/docs/:id', admin, async (req) => {
    const id = idOf(req.params);
    const m = meta.strict().parse(req.body);
    const r = db.prepare('UPDATE documents SET title = ?, category = ?, summary = ?, updated_at = ? WHERE id = ?').run(m.title, m.category, m.summary, nowIso(), id);
    if (!r.changes) throw new HttpError(404, 'document_not_found');
    recordEvent(db, req.user!.id, 'docs.edit', m.title, '');
    return { item: view(one(id)!) };
  });

  app.delete('/api/admin/docs/:id', admin, async (req) => {
    const r = one(idOf(req.params));
    if (!r) throw new HttpError(404, 'document_not_found');
    db.prepare('DELETE FROM documents WHERE id = ?').run(r.id);
    rmSync(fileOf(r.sha256), { force: true });
    recordEvent(db, req.user!.id, 'docs.delete', r.title, r.filename);
    return { ok: true };
  });
}
