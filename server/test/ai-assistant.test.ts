import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeAt, currentStep } from '../src/domain/totp.ts';
import { redactAi } from '../src/domain/ai-redact.ts';
import { ADMIN, testApp } from './helpers.ts';

/** An admin with the second step on: codes for the next steps (anti-replay) and the recovery codes. */
async function setup() {
  const t = await testApp();
  const token = await t.login();
  const H = t.auth(token);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = H) =>
    t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const s = (await call('POST', '/api/auth/totp/setup', { password: ADMIN.password })).json();
  const step = currentStep();
  const en = (await call('POST', '/api/auth/totp/enable', { code: codeAt(s.secret, step) })).json();
  const recovery = [...(en.recoveryCodes as string[])];
  const code = () => recovery.shift()!;
  return { t, H, call, code };
}

describe('Assistente AI: redazione', () => {
  it('removes secrets from the command shown to the admins', () => {
    const out = redactAi('curl -H "Authorization: Bearer abcdefghijklmnop1234" https://admin:pw123@router.example/ --password Segreta1 && export TOKEN=ghp_' + 'a'.repeat(36));
    for (const s of ['abcdefghijklmnop1234', 'pw123', 'Segreta1', 'ghp_aaaa']) assert.ok(!out.includes(s), s);
    assert.match(out, /curl/);
    assert.equal(redactAi('mkdir -p src && npm test'), 'mkdir -p src && npm test', 'ordinary commands stay readable');
    assert.equal(redactAi('x'.repeat(2000), 100).length, 101);
    const env = redactAi('PGPASSWORD=pg1 GITHUB_TOKEN=tk2 AWS_SECRET_ACCESS_KEY=aw3 DB_PASS=db4 psql; curl -u mario:pw5 https://x; mysql -uroot -pmy6 db; sshpass -p ss7 ssh h; curl -H "Authorization: token tt8"');
    for (const s of ['pg1', 'tk2', 'aw3', 'db4', 'pw5', 'my6', 'ss7', 'tt8']) assert.ok(!env.includes(s), `${s} in ${env}`);
  });
});

describe('Assistente AI (modulo ai_assistant)', () => {
  it('off by default; the agent works only with a token made with a fresh code', async () => {
    const { t, call, code } = await setup();
    assert.equal((await call('GET', '/api/admin/ai/agents')).statusCode, 404, 'module off');
    assert.equal((await call('PUT', '/api/admin/modules', { ai_assistant: true })).statusCode, 200);
    assert.equal((await call('POST', '/api/admin/ai/agents', { name: 'PC ufficio', code: '000000' })).statusCode, 401);
    const made = await call('POST', '/api/admin/ai/agents', { name: 'PC ufficio', code: code(), days: 30 });
    assert.equal(made.statusCode, 200, made.body);
    const { token, id } = made.json();
    assert.match(token, /^cdaagt_[A-Za-z0-9_-]{43}$/);
    const stored = t.db.prepare('SELECT token_hash FROM ai_agents WHERE id = ?').get(id) as { token_hash: string };
    assert.notEqual(stored.token_hash, token, 'only the hash is kept');
    const A = { authorization: `Bearer ${token}` };
    assert.equal((await call('POST', '/api/ai-agent/hello', { version: '1.0.0' }, {})).statusCode, 401);
    assert.equal((await call('POST', '/api/ai-agent/hello', { version: '1.0.0' }, { authorization: 'Bearer cdaagt_falso' })).statusCode, 401);
    const hi = await call('POST', '/api/ai-agent/hello', { version: '1.0.0', sessions: [{ ref: 'r1', goal: 'Sito CDA Net', ai: 'claude', state: 'RUNNING', project: 'sito' }] }, A);
    assert.equal(hi.statusCode, 200, hi.body);
    const agents = (await call('GET', '/api/admin/ai/agents')).json().agents;
    assert.equal(agents[0].sessions[0].goal, 'Sito CDA Net');
    assert.ok(agents[0].lastSeenAt);
    // a user session is not an agent token, and an agent token is not a user session
    assert.equal((await call('GET', '/api/admin/ai/agents', undefined, A)).statusCode, 401);
    // module off again: the agent is refused too
    await call('PUT', '/api/admin/modules', { ai_assistant: false });
    assert.equal((await call('POST', '/api/ai-agent/hello', {}, A)).statusCode, 404);
  });

  it('request → notice to the owner without the command → allow with a fresh code → answer to the agent once', async () => {
    const { t, call, code } = await setup();
    await call('PUT', '/api/admin/modules', { ai_assistant: true });
    const { token } = (await call('POST', '/api/admin/ai/agents', { name: 'PC ufficio', code: code() })).json();
    const A = { authorization: `Bearer ${token}` };
    const sent = await call('POST', '/api/ai-agent/requests', { ref: 'p1', sessionRef: 'r1', ai: 'claude', tool: 'Bash', detail: 'npm install --password Segreta1 leaflet' }, A);
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().state, 'pending');
    // the same request again is the same request (the agent may retry)
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'p1', tool: 'Bash' }, A)).json().id, sent.json().id);

    const notes = (await call('GET', '/api/notifications')).json();
    const note = (notes.items ?? notes.notifications ?? notes).find?.((n: { kind: string }) => n.kind === 'ai_permission');
    assert.ok(note, JSON.stringify(notes).slice(0, 300));
    assert.ok(!JSON.stringify(note).includes('npm install'), 'never the command in the notice');

    const list = (await call('GET', '/api/admin/ai/requests?state=pending')).json().requests;
    assert.equal(list.length, 1);
    assert.ok(!list[0].detail.includes('Segreta1'), 'secret removed');
    assert.match(list[0].detail, /npm install/);
    const id = list[0].id;

    assert.deepEqual((await call('GET', '/api/ai-agent/decisions', undefined, A)).json().decisions, []);
    assert.equal((await call('POST', `/api/admin/ai/requests/${id}/decision`, { allow: true })).statusCode, 401, 'allow needs a code');
    assert.equal((await call('POST', `/api/admin/ai/requests/${id}/decision`, { allow: true, code: '000000' })).statusCode, 401);
    const ok = await call('POST', `/api/admin/ai/requests/${id}/decision`, { allow: true, code: code() });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().state, 'allowed');
    assert.equal((await call('POST', `/api/admin/ai/requests/${id}/decision`, { allow: false })).statusCode, 409, 'decided once');

    const d = (await call('GET', '/api/ai-agent/decisions', undefined, A)).json().decisions;
    assert.deepEqual(d, [{ ref: 'p1', allow: true, state: 'allowed' }]);
    // sent again until the agent confirms it (a dropped poll never loses a decision)
    assert.deepEqual((await call('GET', '/api/ai-agent/decisions', undefined, A)).json().decisions, d);
    assert.equal((await call('POST', '/api/ai-agent/decisions/ack', { refs: ['p1'] }, A)).json().acknowledged, 1);
    assert.deepEqual((await call('GET', '/api/ai-agent/decisions', undefined, A)).json().decisions, [], 'confirmed: not sent again');
    const log = t.db.prepare("SELECT detail FROM events WHERE action = 'ai.request.allow'").get() as { detail: string };
    assert.ok(log && !log.detail.includes('npm install'), 'the log has the tool, not the command');
  });

  it('deny needs no code; local-only requests can never be allowed from here; long poll wakes on the answer', async () => {
    const { call, code, t } = await setup();
    await call('PUT', '/api/admin/modules', { ai_assistant: true });
    const { token } = (await call('POST', '/api/admin/ai/agents', { name: 'PC lab', code: code() })).json();
    const A = { authorization: `Bearer ${token}` };
    const local = (await call('POST', '/api/ai-agent/requests', { ref: 'push', tool: 'Bash', detail: 'git push origin main', localOnly: true }, A)).json();
    assert.equal((await call('POST', `/api/admin/ai/requests/${local.id}/decision`, { allow: true, code: code() })).statusCode, 409);
    const other = (await call('POST', '/api/ai-agent/requests', { ref: 'rm', tool: 'Bash', detail: 'rm -rf build' }, A)).json();
    const waiting = t.app.inject({ method: 'GET', url: '/api/ai-agent/decisions?wait=5', headers: A });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call('POST', `/api/admin/ai/requests/${other.id}/decision`, { allow: false })).statusCode, 200);
    const got = (await waiting).json().decisions;
    assert.deepEqual(got, [{ ref: 'rm', allow: false, state: 'denied' }]);
    assert.equal((await call('POST', `/api/admin/ai/requests/${local.id}/decision`, { allow: false })).statusCode, 200, 'a local-only one can be denied');
  });

  it('only the owner decides; unanswered requests expire as denied; the token falls with its admin', async () => {
    const { t, call, code } = await setup();
    await call('PUT', '/api/admin/modules', { ai_assistant: true });
    const { token, id: agentId } = (await call('POST', '/api/admin/ai/agents', { name: 'PC ufficio', code: code() })).json();
    const A = { authorization: `Bearer ${token}` };
    const r = (await call('POST', '/api/ai-agent/requests', { ref: 'x1', tool: 'Bash', detail: 'ls' }, A)).json();
    // another admin: not the owner
    const other = t.db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN.username) as { id: number };
    assert.throws(() => t.ctx.aiAssistant.decide(r.id, other.id + 999, false), /not_agent_owner/);
    // ten minutes later nobody answered
    t.db.prepare('UPDATE ai_permission_requests SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', r.id);
    assert.equal(t.ctx.aiAssistant.expire(), 1);
    assert.deepEqual((await call('GET', '/api/ai-agent/decisions', undefined, A)).json().decisions, [{ ref: 'x1', allow: false, state: 'expired' }]);
    // revoked from the console: the token stops at once
    const second = (await call('POST', '/api/admin/ai/agents', { name: 'PC lab', code: code() })).json();
    const B = { authorization: `Bearer ${second.token}` };
    assert.equal((await call('POST', '/api/ai-agent/hello', {}, B)).statusCode, 200);
    assert.equal((await call('DELETE', `/api/admin/ai/agents/${second.id}`)).statusCode, 200);
    assert.equal((await call('DELETE', `/api/admin/ai/agents/${second.id}`)).statusCode, 404);
    assert.equal((await call('POST', '/api/ai-agent/hello', {}, B)).statusCode, 401);
    // the admin changes password (token_version): every agent token of theirs stops working
    assert.equal((await call('POST', '/api/ai-agent/hello', {}, A)).statusCode, 200);
    t.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(other.id);
    assert.equal((await call('POST', '/api/ai-agent/hello', {}, A)).statusCode, 401);
    assert.ok(agentId);
  });

  it('limits: strict bodies, pending requests per agent, agents per platform', async () => {
    const { call, code } = await setup();
    await call('PUT', '/api/admin/modules', { ai_assistant: true });
    const { token } = (await call('POST', '/api/admin/ai/agents', { name: 'PC 1', code: code() })).json();
    const A = { authorization: `Bearer ${token}` };
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'a', tool: 'Bash', comando: 'x' }, A)).statusCode, 400, 'unknown fields refused');
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'a', tool: 'Bash(curl -H x:segreto)' }, A)).statusCode, 400, 'the tool is a name, never the command');
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'a b…', tool: 'Bash' }, A)).statusCode, 400, 'references are never cleaned into each other');
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'mcp', tool: 'mcp__github__create_pull_request' }, A)).statusCode, 200);
    for (let i = 0; i < 19; i++) assert.equal((await call('POST', '/api/ai-agent/requests', { ref: `q${i}`, tool: 'Bash' }, A)).statusCode, 200);
    assert.equal((await call('POST', '/api/ai-agent/requests', { ref: 'q20', tool: 'Bash' }, A)).statusCode, 429);
    for (let i = 2; i <= 5; i++) assert.equal((await call('POST', '/api/admin/ai/agents', { name: `PC ${i}`, code: code() })).statusCode, 200);
    assert.equal((await call('POST', '/api/admin/ai/agents', { name: 'PC 6', code: code() })).statusCode, 409);
    // wrong codes: five, then a pause (a request that cannot be decided never spends a code)
    const one = (await call('GET', '/api/admin/ai/requests?state=pending')).json().requests[0];
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/api/admin/ai/requests/${one.id}/decision`, { allow: true, code: '000000' })).statusCode, 401);
    assert.equal((await call('POST', `/api/admin/ai/requests/${one.id}/decision`, { allow: true, code: '000000' })).statusCode, 429);
    assert.equal((await call('POST', `/api/admin/ai/requests/${one.id}/decision`, { allow: false })).statusCode, 200, 'deny still works');
    assert.equal((await call('POST', `/api/admin/ai/requests/${one.id}/decision`, { allow: true, code: '000000' })).statusCode, 409, 'checked before the code');
  });

  it('from the app: allow with the phone key unlocked by a strong fingerprint, never with a persistent phone', async () => {
    const { t, call, code, H } = await setup();
    const ANDROID = { 'x-cda-client': 'android/1.42.0' };
    await call('PUT', '/api/admin/modules', { ai_assistant: true });
    const { token } = (await call('POST', '/api/admin/ai/agents', { name: 'PC ufficio', code: code() })).json();
    const A = { authorization: `Bearer ${token}` };
    // a fresh session with the password (and code) registers the phone
    const fresh = (await call('POST', '/api/auth/login', { username: ADMIN.username, password: ADMIN.password }, {})).json();
    const S = fresh.token ? { authorization: `Bearer ${fresh.token}`, ...ANDROID } : null;
    const sess = S ?? { ...H, ...ANDROID };
    const reg = await call('POST', '/api/auth/devices', { name: 'Telefono admin' }, sess);
    const pers = await call('POST', '/api/auth/devices', { name: 'Tablet' , persistent: true }, sess);
    if (reg.statusCode !== 201 || pers.statusCode !== 201) {
      // login with TOTP on needs the code step: the session of setup() is fresh enough
      assert.fail(`device registration: ${reg.statusCode} ${reg.body} / ${pers.statusCode}`);
    }
    const dev = reg.json();
    const tab = pers.json();
    const r1 = (await call('POST', '/api/ai-agent/requests', { ref: 'a1', tool: 'Bash', detail: 'npm test' }, A)).json();
    const r2 = (await call('POST', '/api/ai-agent/requests', { ref: 'a2', tool: 'Bash', detail: 'npm run build' }, A)).json();
    assert.equal((await call('POST', `/api/admin/ai/requests/${r1.id}/decision`, { allow: true, device: { id: tab.id, secret: tab.secret } })).json().error, 'invalid_device', 'persistent phone: no');
    assert.equal((await call('POST', `/api/admin/ai/requests/${r1.id}/decision`, { allow: true, device: { id: dev.id, secret: 'x'.repeat(43) } })).json().error, 'invalid_device');
    const ok = await call('POST', `/api/admin/ai/requests/${r1.id}/decision`, { allow: true, device: { id: dev.id, secret: dev.secret } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().state, 'allowed');
    const log = t.db.prepare("SELECT detail FROM events WHERE action = 'ai.request.allow'").get() as { detail: string };
    assert.match(log.detail, /impronta/);
    // the phone of another account never decides for this admin
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Altro-Admin-Pass-1', role: 'admin' });
    t.db.prepare('UPDATE auth_devices SET user_id = (SELECT id FROM users WHERE username = ?) WHERE id = ?').run('altro', dev.id);
    assert.equal((await call('POST', `/api/admin/ai/requests/${r2.id}/decision`, { allow: true, device: { id: dev.id, secret: dev.secret } })).json().error, 'invalid_device');
  });
});
