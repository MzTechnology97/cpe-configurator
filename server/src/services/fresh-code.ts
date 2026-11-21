import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import type { Db } from '../db.ts';
import { checkSecondFactor, type SecondFactorUser } from './second-factor.ts';

/** Second-step codes (or phone keys) that may be wrong per admin in 10 minutes, on every page that asks for one. */
export const CODE_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;

type AdminRow = SecondFactorUser & { active: number; role: string; token_version: number; totp_enabled: number };

/**
 * A fresh second-step code of an admin who has the second step on (anti-replay inside), for the
 * sensitive actions of the «Approvazioni dei PC» and «Memorie di lavoro» pages. One count of wrong attempts
 * for all of them, so trying on two pages does not double the guesses.
 */
export function createFreshCode(db: Db, sealer: Sealer) {
  const failures = new Map<number, number[]>();
  const recent = (userId: number) => (failures.get(userId) ?? []).filter((t) => t > Date.now() - WINDOW_MS);
  const userRow = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as AdminRow | undefined;
  return {
    /** 429 when this admin already got it wrong too many times. */
    guard(userId: number) {
      if (recent(userId).length >= CODE_FAILURES) throw new HttpError(429, 'too_many_code_attempts');
    },
    failed(userId: number) {
      failures.set(userId, [...recent(userId), Date.now()]);
    },
    passed(userId: number) {
      failures.delete(userId);
    },
    check(userId: number, code: unknown): AdminRow {
      const u = userRow(userId);
      if (!u || !u.active || u.role !== 'admin' || !u.totp_enabled) throw new HttpError(403, 'totp_required');
      this.guard(userId);
      if (typeof code !== 'string' || !code.trim() || !checkSecondFactor(db, sealer, u, code.trim())) {
        this.failed(userId);
        throw new HttpError(401, 'invalid_code');
      }
      this.passed(userId);
      return u;
    },
  };
}
export type FreshCode = ReturnType<typeof createFreshCode>;
