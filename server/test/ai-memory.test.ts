import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { memoryProblem } from '../src/services/ai-memory.ts';
import { MCP_TOOLS } from '../src/services/mcp-tools.ts';
import { ADMIN, testConfig } from './helpers.ts';

const COMMIT = 'a'.repeat(40);
const files: Record<string, string> = {
  'cdanet/hub/memorie/decisioni.md': '# Registro delle decisioni\n- [2026-11-19] Una fonte per ogni dato.\n',
  'cdanet/hub/playbook/sicurezza.md': '# Playbook · Sicurezza\nI segreti stanno nel secret store.\n',
  'cdanet/hub/memorie/segreto.md': '# Da scartare\npassword = Segreta123\n',
  'cdanet/hub/strumenti/installa.ps1': 'non è una memoria',
  'README.md': '# fuori dalle cartelle',
};
const sha = (p: string) => Buffer.from(p).toString('hex').slice(0, 40).padEnd(40, '0');

/** GitHub finto: commit, albero, blob; conta le chiamate e controlla il token. */
function fakeGithub(o: { status?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const h = init?.headers as Record<string, string>;
    if (o.status) return new Response('{}', { status: o.status });
    if (!u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    if (h.authorization !== 'Bearer token_finto_dei_test_non_un_segreto') return new Response('{}', { status: 401 });
    if (u.includes('/commits/main')) return Response.json({ sha: COMMIT });
    if (u.includes(`/git/trees/${COMMIT}`)) return Response.json({ tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', sha: sha(p), size: files[p]!.length })) });
    const blob = Object.keys(files).find((p) => u.endsWith(`/git/blobs/${sha(p)}`));
    if (blob) return Response.json({ encoding: 'base64', content: Buffer.from(files[blob]!).toString('base64') });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function setup(env: Record<string, string> = { AI_HUB_TOKEN: 'token_finto_dei_test_non_un_segreto' }, gh = fakeGithub()) {
  const { app, ctx } = await buildApp(testConfig(env), '1.0.0-test', { db: openDatabase(':memory:'), logger: false, fetchImpl: gh.fetchImpl });
  await app.ready();
  const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().token as string;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { app, ctx, call, gh };
}

describe('Conoscenza AI (modulo ai_memory)', () => {
  it('reads only the Markdown of the two folders, refuses files with secrets and tells the NOC', async () => {
    const { ctx, call } = await setup();
    assert.equal((await call('GET', '/api/admin/ai/memory')).statusCode, 404, 'module off');
    await call('PUT', '/api/admin/modules', { ai_memory: true });
    const alerts: string[] = [];
    const orig = ctx.notify.security;
    ctx.notify.security = (t: string) => {
      alerts.push(t);
      orig(t);
    };
    const r = await call('POST', '/api/admin/ai/memory/refresh');
    assert.equal(r.statusCode, 200, r.body);
    const { state, files: list } = r.json();
    assert.equal(state.ok, true);
    assert.equal(state.commit, COMMIT);
    assert.deepEqual(list.map((f: { path: string }) => f.path), ['cdanet/hub/memorie/decisioni.md', 'cdanet/hub/playbook/sicurezza.md']);
    assert.equal(list[0].title, 'Registro delle decisioni');
    assert.deepEqual(state.skipped, [{ path: 'cdanet/hub/memorie/segreto.md', reason: 'possibile password in chiaro' }]);
    assert.equal(alerts.length, 1);
    assert.ok(!alerts[0]!.includes('Segreta123'), 'never the content in the alert');
    const f = await call('GET', `/api/admin/ai/memory/file?path=${encodeURIComponent('cdanet/hub/memorie/decisioni.md')}`);
    assert.match(f.json().content, /Una fonte per ogni dato/);
    assert.equal((await call('GET', '/api/admin/ai/memory/file?path=cdanet/hub/memorie/segreto.md')).statusCode, 404);
    // a second reading with the same files: no new alert
    await call('POST', '/api/admin/ai/memory/refresh');
    assert.equal(alerts.length, 1);
  });

  it('a refused token keeps the old copy and shows the error, never the token', async () => {
    const good = await setup();
    await good.call('PUT', '/api/admin/modules', { ai_memory: true });
    await good.call('POST', '/api/admin/ai/memory/refresh');
    const bad = await setup({ AI_HUB_TOKEN: 'token_finto_dei_test_non_un_segreto' }, fakeGithub({ status: 401 }));
    await bad.call('PUT', '/api/admin/modules', { ai_memory: true });
    const s = (await bad.call('POST', '/api/admin/ai/memory/refresh')).json().state;
    assert.equal(s.ok, false);
    assert.match(s.error, /rifiutato il token/);
    assert.ok(!JSON.stringify(s).includes('token_finto'));
  });

  it('without a token nothing is read and the page says so', async () => {
    const gh = fakeGithub();
    const { call } = await setup({}, gh);
    await call('PUT', '/api/admin/modules', { ai_memory: true });
    const s = (await call('GET', '/api/admin/ai/memory')).json().state;
    assert.equal(s.configured, false);
    await call('POST', '/api/admin/ai/memory/refresh');
    assert.equal(gh.calls.length, 0);
  });

  it('MCP tool memorie_cdanet: index without arguments, a file with «file»', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'memorie_cdanet')!;
    assert.ok(t && !t.method, 'read only');
    assert.equal(t.path({}), '/api/admin/ai/memory');
    assert.equal(t.path({ file: 'cdanet/hub/memorie/decisioni.md' }), '/api/admin/ai/memory/file?path=cdanet%2Fhub%2Fmemorie%2Fdecisioni.md');
  });

  it('the same checks as the repository', () => {
    assert.equal(memoryProblem('I segreti stanno nel secret store.'), null);
    assert.equal(memoryProblem('JWT_SECRET=${JWT_SECRET}'), null);
    // split so the repository's own secret scan (CI) does not flag the test itself
    assert.ok(memoryProblem('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'));
    assert.ok(memoryProblem('token cdasvc_' + 'a'.repeat(30)));
  });
});
