import { nowIso, type DB } from '../db/database.js';

/**
 * Failure injection for the *simulated environment*.
 *
 * An operator arms a failure for an operation (e.g. "access.set_entitlements").
 * The next time that operation runs, the service consumes the injection and
 * fails the way a real system might. The agent runtime knows nothing about
 * this table; it only sees the resulting error from the tool.
 */
export const FAILURE_KINDS = {
  transient_503: 'One-time 503 Service Unavailable from the access provisioning API',
  workspace_suspended: 'The workspace gets suspended by a (simulated) billing sync job right before provisioning',
} as const;

export type FailureKind = keyof typeof FAILURE_KINDS;
export const FAILURE_OPERATIONS = ['access.set_entitlements'] as const;
export type FailureOperation = (typeof FAILURE_OPERATIONS)[number];

export function injectFailure(db: DB, operation: FailureOperation, kind: FailureKind, times = 1) {
  db.prepare('INSERT INTO failure_injections (operation, kind, remaining, created_at) VALUES (?, ?, ?, ?)').run(
    operation,
    kind,
    times,
    nowIso(),
  );
}

export function clearFailures(db: DB) {
  db.prepare('DELETE FROM failure_injections').run();
}

export function listActiveFailures(db: DB) {
  return db
    .prepare('SELECT id, operation, kind, remaining FROM failure_injections WHERE remaining > 0 ORDER BY id')
    .all() as { id: number; operation: string; kind: FailureKind; remaining: number }[];
}

/** Atomically take one pending failure for this operation, if any. */
export function consumeFailure(db: DB, operation: FailureOperation): FailureKind | null {
  const row = db
    .prepare('SELECT id, kind FROM failure_injections WHERE operation = ? AND remaining > 0 ORDER BY id LIMIT 1')
    .get(operation) as { id: number; kind: FailureKind } | undefined;
  if (!row) return null;
  db.prepare('UPDATE failure_injections SET remaining = remaining - 1 WHERE id = ?').run(row.id);
  return row.kind;
}
