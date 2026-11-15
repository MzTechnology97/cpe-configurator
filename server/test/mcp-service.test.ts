import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeAt, currentStep } from '../src/domain/totp.ts';
import { ADMIN, testApp } from './helpers.ts';

describe('Token di servizio MCP (CRM interno, sola lettura)', () => {
  it('created with a fresh code, read only, listed and revocable', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    const create = (o: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/admin/mcp/service-tokens', headers: H, payload: o });
    // no second step yet: refused
    assert.equal((await create({ name: 'CRM interno', code: '123456' })).statusCode, 403);
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: H, payload: { password: ADMIN.password } })).json();
    const step = currentStep();
    const en = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: H, payload: { code: codeAt(setup.secret, step) } })).json();
    const rc = en.recoveryCodes as string[];
    assert.equal((await create({ name: 'CRM interno', code: '000000' })).statusCode, 401);
    assert.equal((await create({ name: 'x', code: rc[0]! })).statusCode, 400);
    const ok = await create({ name: 'CRM interno', code: rc[1]!, days: 30 });
    assert.equal(ok.statusCode, 200, ok.body);
    const { token, name, expiresAt, id } = ok.json();
    assert.match(token, /^cdasvc_/);
    assert.equal(name, 'Servizio · CRM interno');
    assert.ok(new Date(expiresAt).getTime() - Date.now() < 31 * 86_400_000);

    const rpc = (body: object, tok = token) => t.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tok}` }, payload: body });
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.statusCode, 200, init.body);
    assert.match(init.json().result.instructions, /solo lettura/);
    const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    assert.ok(tools.length > 10);
    assert.ok(tools.every((x) => x.annotations.readOnlyHint), 'read-only tools only');
    const w = (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'elimina_intervento', arguments: { id: 1 } } })).json().result;
    assert.equal(w.isError, true);
    const r = (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'utenti', arguments: {} } })).json().result;
    assert.ok(!r.isError, JSON.stringify(r));

    // the PPPoE export, a page at a time, without personal data (made-up accounts)
    const ins = t.db.prepare('INSERT INTO crm_radius(account_id, username, account_status, profile, customer_name, online, client_ip, session_seconds, checked_at) VALUES(?,?,?,?,?,?,?,?,?)');
    ins.run('a1', 'beta@example.it', 'Attivo', 'HOME-30-6', 'BETA SRL', 1, '10.0.0.2', 3600, '2026-11-15T10:00:00.000Z');
    ins.run('a2', 'alfa@example.it', 'Attivo', 'HOME-30-6', 'ALFA ANNA', 0, null, null, '2026-11-15T10:00:00.000Z');
    ins.run('a3', 'gamma@example.it', 'Terminato', 'HOME-30-6', 'GAMMA', 0, null, null, null);
    const exp = async (args: object) => JSON.parse((await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'sessioni_pppoe_export', arguments: args } })).json().result.content[0].text).dati;
    const p1 = await exp({ limit: 1 });
    assert.equal(p1.total, 2, 'terminated accounts only on request');
    assert.deepEqual(p1.items.map((x: { login: string }) => x.login), ['alfa@example.it']);
    assert.ok(p1.nextCursor);
    assert.ok(!JSON.stringify(p1).includes('ANNA'), 'no customer names');
    const p2 = await exp({ limit: 1, cursor: p1.nextCursor });
    assert.equal(p2.items[0].login, 'beta@example.it');
    assert.equal(p2.items[0].sessionStart, '2026-11-15T09:00:00.000Z');
    assert.equal(p2.items[0].ip, '10.0.0.2');
    assert.equal(p2.nextCursor, null);
    assert.equal((await exp({ terminated: true })).total, 3);

    // in the list of the connections, then revoked
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/mcp', headers: H })).json();
    const row = list.connections.find((c: { id: number }) => c.id === id);
    assert.equal(row.client, 'Servizio · CRM interno');
    assert.equal(row.active, true);
    assert.equal(row.canWrite, false);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/mcp/connections/${id}`, headers: H })).statusCode, 200);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).statusCode, 401);
  });
});
