import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { DEFAULT_SERVICES, median, probeUrlProblem, readGoogle, readStatuspage, stateOf } from '../src/services/ott-monitor.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Servizi OTT e CDN: helpers', () => {
  it('accepts only public web addresses', () => {
    assert.equal(probeUrlProblem('https://www.example.com/'), null);
    for (const bad of ['ftp://example.com/', 'https://localhost/', 'http://192.168.1.1/', 'https://user:pw@example.com/', 'https://intranet/', 'non un indirizzo']) assert.notEqual(probeUrlProblem(bad), null, bad);
    for (const s of DEFAULT_SERVICES) assert.equal(probeUrlProblem(s.probeUrl), null, s.name);
  });

  it('reads the official status pages', () => {
    assert.deepEqual(readStatuspage({ status: { indicator: 'none', description: 'All Systems Operational' }, incidents: [] }), { official: 'ok', text: 'All Systems Operational' });
    assert.equal(readStatuspage({ status: { indicator: 'major' }, incidents: [{ name: 'Rete degradata', status: 'investigating' }] }).text, 'Rete degradata');
    assert.equal(readStatuspage({ status: { indicator: 'minor' } }).official, 'minor');
    assert.equal(readStatuspage('<html>').official, 'sconosciuto');
    assert.equal(readGoogle([{ end: '2026-01-01', severity: 'high' }]).official, 'ok');
    assert.equal(readGoogle([{ severity: 'high', service_name: 'Gmail', external_desc: 'Errori\naltro' }]).text, 'Gmail: Errori');
  });

  it('down after 3 failures in a row, slow only when twice over 3 times the usual', () => {
    assert.equal(stateOf([], null), 'sconosciuto');
    assert.equal(stateOf([{ ok: true, ms: 100 }, { ok: false, ms: null }, { ok: false, ms: null }], 100), 'ok', 'two failures are not an outage');
    assert.equal(stateOf([{ ok: false, ms: null }, { ok: false, ms: null }, { ok: false, ms: null }], 100), 'irraggiungibile');
    assert.equal(stateOf([{ ok: true, ms: 2000 }, { ok: true, ms: 2500 }], 300), 'lento');
    assert.equal(stateOf([{ ok: true, ms: 200 }, { ok: true, ms: 2500 }], 300), 'ok');
    assert.equal(median([300, 100, 200]), 200);
  });
});

describe('Servizi OTT e CDN: modulo', () => {
  it('probes from our network, official pages, notices for one service and for our exit', async () => {
    let broken = new Set<string>(['www.netflix.com']);
    const fetchImpl = (async (input: string | URL) => {
      const u = new URL(String(input));
      if (u.pathname === '/api/v2/summary.json') return Response.json({ status: { indicator: u.hostname === 'www.cloudflarestatus.com' ? 'minor' : 'none', description: 'ok' }, incidents: [] });
      if (u.hostname === 'www.google.com' && u.pathname.endsWith('incidents.json')) return Response.json([]);
      if (broken.has(u.hostname) || broken.has('*')) throw new Error('connect ECONNREFUSED');
      return new Response(null, { status: u.pathname === '/generate_204' ? 204 : 200 });
    }) as typeof fetch;
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl, telegramIntervalMs: 0 });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const A = { authorization: `Bearer ${tok}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: A, payload });

    assert.equal((await call('GET', '/api/ott')).statusCode, 404, 'module off by default');
    await call('PUT', '/api/admin/modules', { ott_monitor: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/ott' })).statusCode, 401);

    // the first round: the state becomes known, nobody notified
    let d = (await call('POST', '/api/admin/ott/check')).json();
    assert.equal(d.services.length, DEFAULT_SERVICES.length);
    const by = (name: string) => d.services.find((s: { name: string }) => s.name === name);
    assert.equal(by('YouTube').state, 'ok');
    assert.equal(by('Cloudflare').official, 'minor');
    assert.equal(by('Netflix').state, 'ok', 'one failure is not an outage');

    for (let i = 0; i < 3; i++) d = (await call('POST', '/api/admin/ott/check')).json();
    assert.equal(by('Netflix').state, 'irraggiungibile');
    assert.equal(d.outage.ours, false);
    const notes = () => (ctx.db.prepare("SELECT title FROM notifications WHERE kind = 'ott'").all() as Array<{ title: string }>).map((n) => n.title);
    assert.ok(notes().some((t) => t.includes('Netflix')), notes().join(' | '));

    // everything fails together: one notice, on our exit
    broken = new Set(['*']);
    for (let i = 0; i < 3; i++) d = (await call('POST', '/api/admin/ott/check')).json();
    assert.equal(d.outage.ours, true);
    assert.ok(notes().some((t) => t.includes('irraggiungibili insieme')));
    assert.ok(by('YouTube').spark.length >= 1);

    // the admins change the list
    assert.equal((await call('POST', '/api/admin/ott', { name: 'Interno', category: 'altro', probeUrl: 'http://10.0.0.1/', statusKind: 'none' })).statusCode, 400);
    const x = (await call('POST', '/api/admin/ott', { name: 'Servizio di prova', category: 'altro', probeUrl: 'https://servizio.example.com/', statusKind: 'none' })).json();
    assert.equal((await call('PUT', `/api/admin/ott/${x.id}`, { name: 'Servizio di prova', category: 'altro', probeUrl: 'https://servizio.example.com/', statusKind: 'none', enabled: false })).json().enabled, false);
    assert.equal((await call('DELETE', `/api/admin/ott/${x.id}`)).statusCode, 200);
    await app.close();
  });
});
