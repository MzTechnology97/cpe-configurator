import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { codeAt, currentStep } from '../src/domain/totp.ts';
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
const ENV_TOKEN = 'token_finto_dei_test_non_un_segreto';
// built at run time so the repository's own secret scan (CI) does not flag the test itself
const CONSOLE_TOKEN = 'github_pat' + '_' + 'T'.repeat(60);
const REFUSED_TOKEN = 'github_pat' + '_' + 'R'.repeat(60);

/** GitHub finto: commit, albero, blob; conta le chiamate e controlla il token. */
function fakeGithub(o: { status?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const h = init?.headers as Record<string, string>;
    if (o.status) return new Response('{}', { status: o.status });
    if (!u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    if (h.authorization !== `Bearer ${ENV_TOKEN}` && h.authorization !== `Bearer ${CONSOLE_TOKEN}`) return new Response('{}', { status: 401 });
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
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { app, ctx, call, gh };
}

/** Second step on for the admin: one recovery code per sensitive action. */
async function codes(call: Awaited<ReturnType<typeof setup>>['call']) {
  const s = (await call('POST', '/api/auth/totp/setup', { password: ADMIN.password })).json();
  const en = (await call('POST', '/api/auth/totp/enable', { code: codeAt(s.secret, currentStep()) })).json();
  const left = [...(en.recoveryCodes as string[])];
  return () => left.shift()!;
}

describe('Memorie di lavoro (modulo ai_memory)', () => {
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

  it('token from the console: fresh code, tried on GitHub first, sealed, never shown again; removable', async () => {
    const { ctx, call } = await setup({});
    await call('PUT', '/api/admin/modules', { ai_memory: true });
    const alerts: string[] = [];
    const orig = ctx.notify.security;
    ctx.notify.security = (t: string) => {
      alerts.push(t);
      orig(t);
    };
    assert.equal((await call('PUT', '/api/admin/ai/memory/token', { token: CONSOLE_TOKEN, code: '123456' })).statusCode, 403, 'second step off');
    const code = await codes(call);
    assert.equal((await call('PUT', '/api/admin/ai/memory/token', { token: CONSOLE_TOKEN, code: '000000' })).statusCode, 401);
    assert.equal((await call('PUT', '/api/admin/ai/memory/token', { token: 'ghp_' + 'a'.repeat(36), code: code() })).json().error, 'hub_token_format', 'classic tokens refused');
    const refused = await call('PUT', '/api/admin/ai/memory/token', { token: REFUSED_TOKEN, code: code() });
    assert.equal(refused.statusCode, 400);
    assert.ok(!refused.body.includes('RRRR'), 'never the token in the answer');
    assert.equal((await call('GET', '/api/admin/ai/memory')).json().state.configured, false, 'a refused token is not saved');

    const ok = await call('PUT', '/api/admin/ai/memory/token', { token: CONSOLE_TOKEN, code: code() });
    assert.equal(ok.statusCode, 200, ok.body);
    const { state, files: list } = ok.json();
    assert.equal(state.configured, true);
    assert.equal(state.tokenSource, 'console');
    assert.equal(state.tokenSetBy, ADMIN.username);
    assert.equal(list.length, 2, 'read right away');
    for (const r of [ok, await call('GET', '/api/admin/ai/memory')]) assert.ok(!r.body.includes('TTTT'), 'never shown again');
    const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'ai_memory_token'").get() as { value: string };
    assert.ok(!row.value.includes('TTTT'), 'sealed at rest');
    assert.ok(alerts.some((a) => a.includes('inserito')));
    assert.ok(!alerts.join(' ').includes('TTTT'));

    const del = await call('DELETE', '/api/admin/ai/memory/token');
    assert.equal(del.json().state.configured, false);
    assert.equal(del.json().files.length, 2, 'the copy already read stays');
    assert.ok(alerts.some((a) => a.includes('tolto')));
  });

  it('the token in the .env wins: the console cannot change it', async () => {
    const { call } = await setup();
    await call('PUT', '/api/admin/modules', { ai_memory: true });
    const code = await codes(call);
    assert.equal((await call('GET', '/api/admin/ai/memory')).json().state.tokenSource, 'env');
    assert.equal((await call('PUT', '/api/admin/ai/memory/token', { token: CONSOLE_TOKEN, code: code() })).statusCode, 409);
    assert.equal((await call('DELETE', '/api/admin/ai/memory/token')).statusCode, 409);
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
