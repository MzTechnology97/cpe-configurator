import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN, testApp } from './helpers.ts';

// a made-up PDF: no supplier document in the repository
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

describe('Manuali e documentazione', () => {
  it('admins upload PDFs, the staff reads them, installers do not', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    const up = (body: Buffer, q: string, type = 'application/pdf') => t.app.inject({ method: 'POST', url: `/api/admin/docs?${q}`, headers: { ...H, 'content-type': type }, payload: body });
    const q = new URLSearchParams({ title: 'Scheda di prova', category: 'FWA', summary: 'Riassunto breve', name: 'scheda prova.pdf' }).toString();

    assert.equal((await up(Buffer.from('non un pdf'), q)).statusCode, 400);
    const ok = await up(PDF, q);
    assert.equal(ok.statusCode, 201, ok.body);
    const item = ok.json().item;
    assert.equal(item.filename, 'scheda_prova.pdf');
    assert.equal((await up(PDF, q)).statusCode, 409, 'same file twice');

    const list = (await t.app.inject({ method: 'GET', url: '/api/docs', headers: H })).json().items;
    assert.equal(list.length, 1);
    assert.equal(list[0].summary, 'Riassunto breve');
    const file = await t.app.inject({ method: 'GET', url: `/api/docs/${item.id}/file`, headers: H });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/pdf');
    assert.ok(file.rawPayload.equals(PDF));

    // an installer: no list, no file, no upload
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const I = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/docs', headers: I })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/docs/${item.id}/file`, headers: I })).statusCode, 403);
    // without login
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/docs/${item.id}/file` })).statusCode, 401);

    const ed = await t.app.inject({ method: 'PUT', url: `/api/admin/docs/${item.id}`, headers: H, payload: { title: 'Scheda rinominata', category: 'FWA', summary: '' } });
    assert.equal(ed.json().item.title, 'Scheda rinominata');
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/docs/${item.id}`, headers: H })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/docs/${item.id}/file`, headers: H })).statusCode, 404);
    void ADMIN;
    await t.app.close();
  });
});
