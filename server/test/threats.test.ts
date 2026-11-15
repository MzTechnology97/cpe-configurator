import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { cleanIndicators, pwnedCount, pwnedSplit, stringsOf, victimMatches, victimOf, victimsOf } from '../src/services/threats.ts';
import { ADMIN, testConfig } from './helpers.ts';

// made-up companies, domains, addresses (documentation ranges) and groups: no real data
describe('Minacce: helpers', () => {
  it('cleans the indicators and names the wrong ones', () => {
    const c = cleanIndicators({ domains: ['https://www.Esempio.it/x', 'esempio.it', 'no dominio'], ips: ['192.0.2.10', '2001:db8::1', '999.1.1.1'], emails: ['NOC@esempio.it', 'senza-chiocciola'] });
    assert.deepEqual(c.domains, ['esempio.it']);
    assert.deepEqual(c.ips, ['192.0.2.10', '2001:db8::1']);
    assert.deepEqual(c.emails, ['noc@esempio.it']);
    assert.deepEqual(c.invalid, ['no dominio', '999.1.1.1', 'senza-chiocciola']);
  });

  it('reads victims in both shapes and matches domain and whole names only', () => {
    assert.equal(victimsOf({ victims: [{ victim: 'a' }] }).length, 1);
    assert.equal(victimsOf([{ post_title: 'b' }]).length, 1);
    const v = victimOf({ post_title: 'Fornitore Esempio Srl', group_name: 'gruppo-x', website: 'https://www.fornitore-esempio.it', published: '2026-10-05' });
    assert.deepEqual([v.title, v.group, v.publishedAt], ['Fornitore Esempio Srl', 'gruppo-x', '2026-10-05']);
    assert.ok(victimMatches(v, { domain: 'fornitore-esempio.it' }));
    assert.ok(!victimMatches(v, { domain: 'esempio.it' }), 'another domain ending the same way is not ours');
    assert.ok(victimMatches(v, { name: 'Fornitore Esempio' }));
    assert.ok(!victimMatches(v, { name: 'Fornitore Esem' }), 'whole words only');
    assert.ok(stringsOf({ a: [{ ip: '192.0.2.10' }, 'X@Esempio.it'] }).has('x@esempio.it'));
  });

  it('k-anonymity: 5 characters out, the rest compared here', () => {
    const { prefix, suffix } = pwnedSplit('password');
    assert.equal(prefix, '5BAA6');
    assert.equal(suffix.length, 35);
    assert.equal(pwnedCount(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:42\r\nAAAA:0`, suffix), 42);
    assert.equal(pwnedCount('0018A45C4D1DEF81644B54AB7F969B88D65:1', suffix), 0);
  });
});

describe('Minacce: modulo', () => {
  it('assets, daily check on ransomware.live, NOC notice once, password never stored', async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const u = String(input);
      calls.push({ url: u, key: new Headers(init?.headers).get('x-api-key') });
      if (u.startsWith('https://api.pwnedpasswords.com/range/')) return new Response(`${'0'.repeat(35)}:3\r\n`);
      if (u.includes('/victims/search?q=fornitore-esempio.it'))
        return Response.json({ victims: [{ post_title: 'Fornitore Esempio Srl', group_name: 'gruppo-x', website: 'fornitore-esempio.it', published: '2026-10-05', post_url: 'https://rl.example/v/1' }] });
      if (u.includes('/victims/search')) return Response.json({ victims: [{ post_title: 'Altra Azienda', website: 'altra.example', group_name: 'gruppo-y' }] });
      if (u.endsWith('/iocs')) return Response.json(['gruppo-x', 'gruppo-y']);
      if (u.endsWith('/iocs/gruppo-x')) return Response.json({ ip: ['198.51.100.7', '192.0.2.10'], email: [] });
      if (u.endsWith('/iocs/gruppo-y')) return Response.json({ domain: ['cattivo.example'] });
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const cfg = testConfig({ RANSOMWARE_LIVE_API_KEY: 'test-key-not-real', RANSOMWARE_LIVE_URL: 'https://rl-api.example' });
    const { app, ctx } = await buildApp(cfg, 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl, telegramIntervalMs: 0 });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const A = { authorization: `Bearer ${tok}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: A, payload });

    assert.equal((await call('GET', '/api/admin/threats')).statusCode, 404, 'module off by default');
    await call('PUT', '/api/admin/modules', { threats: true });

    const bad = await call('POST', '/api/admin/threats/assets', { name: 'Router di bordo', kind: 'sistema', domains: [], ips: ['300.1.1.1'], emails: [] });
    assert.equal(bad.statusCode, 400);
    const ours = (await call('POST', '/api/admin/threats/assets', { name: 'Router di bordo', kind: 'sistema', domains: ['esempio.it'], ips: ['192.0.2.10'], emails: ['noc@esempio.it'] })).json();
    const sup = (await call('POST', '/api/admin/threats/assets', { name: 'Fornitore Esempio', kind: 'fornitore', searchName: true, domains: ['fornitore-esempio.it'], ips: [], emails: [] })).json();
    assert.ok(ours.id && sup.id);

    const run = (await call('POST', '/api/admin/threats/check')).json();
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(run.fresh, 2, 'the supplier among the victims and our IP in the indicators');
    assert.ok(calls.every((c) => !c.url.includes('192.0.2.10') && !c.url.includes('noc%40esempio.it')), 'our IPs and emails never leave the server');
    assert.ok(calls.filter((c) => c.url.startsWith('https://rl-api.example')).every((c) => c.key === 'test-key-not-real'));

    const d = (await call('GET', '/api/admin/threats')).json();
    assert.deepEqual(d.hits.map((h: { source: string; assetName: string }) => `${h.source}:${h.assetName}`).sort(), ['ioc:Router di bordo', 'victim:Fornitore Esempio']);
    const inbox = ctx.db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'threats'").get() as { n: number };
    assert.ok(inbox.n >= 2);

    // the same hits again: no new notice
    const again = (await call('POST', '/api/admin/threats/check')).json();
    assert.equal(again.fresh, 0);

    // the password: checked, never stored
    const secret = 'Una-Password-Di-Prova-1';
    const pw = await call('POST', `/api/admin/threats/assets/${ours.id}/password`, { label: 'admin router', password: secret });
    assert.equal(pw.statusCode, 200, pw.body);
    assert.equal(pw.json().seen, 0);
    const dump = JSON.stringify(ctx.db.prepare("SELECT * FROM threat_password_checks").all()) + JSON.stringify(ctx.db.prepare('SELECT * FROM events').all());
    assert.ok(!dump.includes(secret), 'the password is nowhere');
    const pwCall = calls.find((c) => c.url.includes('/range/'))!;
    assert.match(pwCall.url, /\/range\/[0-9A-F]{5}$/, 'only 5 characters of the hash go out');

    // deleting the asset removes its hits
    assert.equal((await call('DELETE', `/api/admin/threats/assets/${sup.id}`)).statusCode, 200);
    assert.equal((await call('GET', '/api/admin/threats')).json().hits.length, 1);
    await app.close();
  });
});
