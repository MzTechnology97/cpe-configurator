import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

describe('Esito di un\'installazione tutto o niente', () => {
  it('a write that fails halfway leaves nothing, and the retry closes the work order', async () => {
    const t = await testApp();
    const admin = { id: 1, role: 'admin' };
    const now = new Date().toISOString();
    const order = () => {
      const wo = Number(
        t.db.prepare("INSERT INTO work_orders(created_at, updated_at, day, kind, customer) VALUES(?, ?, '2026-10-25', 'new', 'Cliente Demo')").run(now, now).lastInsertRowid,
      );
      const id = randomUUID();
      t.db
        .prepare(
          `INSERT INTO provisioning_jobs(id, created_at, expires_at, user_id, model, mac, serial, ssid, pppoe_user, status, work_order_id)
           VALUES(?, ?, ?, 1, 'LiteBeam 5AC', 'AA:BB:CC:00:00:09', 'S1', 'CDA-NET-N2-D01', 'demo@example.invalid', 'prepared', ?)`,
        )
        .run(id, now, now, wo);
      return { id, wo };
    };
    const status = (table: string, id: string | number) => (t.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;
    const ok = { result: 'success' as const, stages: [], detected: {}, error: '' };

    const a = order();
    t.db.exec("CREATE TRIGGER fail_order BEFORE UPDATE ON work_orders BEGIN SELECT RAISE(ABORT, 'guasto di prova'); END");
    assert.throws(() => t.ctx.provisioning.recordResult(a.id, admin, ok));
    assert.equal(status('provisioning_jobs', a.id), 'prepared', 'the job is not left successful on its own');
    t.db.exec('DROP TRIGGER fail_order');
    assert.equal(t.ctx.provisioning.recordResult(a.id, admin, ok).duplicate, false);
    assert.equal(status('work_orders', a.wo), 'done');

    // left half done by an older version: the repeated success mends it
    const b = order();
    t.db.prepare("UPDATE provisioning_jobs SET status = 'success' WHERE id = ?").run(b.id);
    assert.equal(t.ctx.provisioning.recordResult(b.id, admin, ok).duplicate, true);
    assert.equal(status('work_orders', b.wo), 'done');
    await t.app.close();
  });
});
