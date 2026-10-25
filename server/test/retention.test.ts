import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

describe('Conservazione dei dati (pulizia periodica)', () => {
  it('keeps installed CPEs with their acceptance test, deletes old attempts and logs after the notice months', async () => {
    const t = await testApp();
    const job = (id: string, status: string, age: number) =>
      t.db
        .prepare(
          `INSERT INTO provisioning_jobs(id, created_at, expires_at, user_id, model, mac, serial, ssid, pppoe_user, status)
           VALUES(?, ?, ?, 1, 'LiteBeam 5AC', 'AA:BB:CC:00:00:01', 'S1', 'CDA-NET-N2-D01', 'demo@example.invalid', ?)`,
        )
        .run(id, daysAgo(age), daysAgo(age), status);
    const speed = (jobId: string | null, age: number) =>
      t.db
        .prepare("INSERT INTO speed_tests(created_at, measured_at, context, job_id, down_mbps) VALUES(?, ?, 'acceptance', ?, 100)")
        .run(daysAgo(age), daysAgo(age), jobId);
    const event = (target: string, age: number) =>
      t.db.prepare("INSERT INTO events(created_at, action, target) VALUES(?, 'prova', ?)").run(daysAgo(age), target);

    job('installed-old', 'success', 1000);
    t.db.prepare("INSERT INTO job_acceptance(job_id, created_at, user_id, verdict, data) VALUES('installed-old', ?, 1, 'ok', '{}')").run(daysAgo(1000));
    speed('installed-old', 1000);
    job('failed-old', 'failed', 1000);
    speed('failed-old', 1000);
    speed(null, 1000);
    job('failed-recent', 'failed', 400);
    event('old', 1000);
    event('recent', 400);

    // without the privacy notice: Impostazioni server (365 days in the tests)
    t.ctx.provisioning.housekeeping();
    const ids = () => (t.db.prepare('SELECT id FROM provisioning_jobs ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    assert.deepEqual(ids(), ['installed-old'], 'only the installation survives the attempts older than a year');
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM job_acceptance WHERE job_id = 'installed-old'").get() as { n: number }).n, 1);
    const speeds = t.db.prepare('SELECT job_id FROM speed_tests').all() as Array<{ job_id: string | null }>;
    assert.deepEqual(speeds.map((s) => s.job_id), ['installed-old'], "the acceptance test's speed test stays with the installation");
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0);

    // the notice the users accepted wins: 24 months keep the log of 400 days ago
    job('failed-recent', 'failed', 400);
    event('recent', 400);
    t.db
      .prepare("INSERT INTO settings(key, value, updated_at) VALUES('privacy.controller', ?, ?)")
      .run(JSON.stringify({ name: 'Azienda Demo S.r.l.', retentionMonths: 24 }), daysAgo(0));
    t.ctx.provisioning.housekeeping();
    assert.deepEqual(ids(), ['failed-recent', 'installed-old']);
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE target = 'recent'").get() as { n: number }).n, 1);
    await t.app.close();
  });
});
