import { nowIso, type DB } from '../../db/database.js';
import { ServiceError } from '../errors.js';
import { consumeFailure } from '../failures.js';
import { getPlan, getSubscription } from '../billing/service.js';

interface WorkspaceRow {
  id: string;
  customer_id: string;
  name: string;
  status: string;
  status_reason: string | null;
}

function loadWorkspace(db: DB, workspaceId: string): WorkspaceRow {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  if (!ws) throw new ServiceError('WORKSPACE_NOT_FOUND', `No workspace with id '${workspaceId}'.`, 404);
  return ws;
}

export function listFeatures(db: DB) {
  return db.prepare('SELECT key, description FROM features ORDER BY key').all() as { key: string; description: string }[];
}

export function getEnabledFeatures(db: DB, workspaceId: string): string[] {
  return (
    db.prepare('SELECT feature FROM entitlements WHERE workspace_id = ? ORDER BY feature').all(workspaceId) as { feature: string }[]
  ).map((r) => r.feature);
}

export function getWorkspace(db: DB, workspaceId: string) {
  const ws = loadWorkspace(db, workspaceId);
  const sub = getSubscription(db, ws.customer_id);
  const allowed = getPlan(db, sub.plan_id).entitlements;
  const enabled = getEnabledFeatures(db, workspaceId);
  return {
    ...ws,
    customer_plan: sub.plan_id,
    enabled_entitlements: enabled,
    allowed_by_current_plan: allowed,
    // Plain fact about current state; the agent decides what (if anything) to do about it.
    enabled_but_not_in_plan: enabled.filter((f) => !allowed.includes(f)),
  };
}

export function listWorkspaces(db: DB, customerId?: string) {
  const rows = (
    customerId
      ? db.prepare('SELECT id FROM workspaces WHERE customer_id = ? ORDER BY id').all(customerId)
      : db.prepare('SELECT id FROM workspaces ORDER BY id').all()
  ) as { id: string }[];
  return rows.map((r) => getWorkspace(db, r.id));
}

/**
 * Enable and/or disable features on a workspace.
 * Naturally idempotent: enabling an enabled feature or disabling a disabled one is a no-op.
 */
export function setEntitlements(db: DB, workspaceId: string, enable: string[], disable: string[]) {
  const ws = loadWorkspace(db, workspaceId);

  // --- Simulated environment failures (see failures.ts). ---
  const injected = consumeFailure(db, 'access.set_entitlements');
  if (injected === 'transient_503') {
    throw new ServiceError(
      'SERVICE_UNAVAILABLE',
      'Access provisioning service is temporarily unavailable (503). No changes were applied.',
      503,
      true,
    );
  }
  if (injected === 'workspace_suspended') {
    db.prepare('UPDATE workspaces SET status = ?, status_reason = ? WHERE id = ?').run(
      'suspended',
      'Suspended by automated billing sync (simulated incident)',
      workspaceId,
    );
    ws.status = 'suspended';
  }

  // --- Domain rules (deterministic). ---
  if (ws.status !== 'active') {
    throw new ServiceError(
      'WORKSPACE_INACTIVE',
      `Workspace '${workspaceId}' is ${ws.status}; entitlement changes require an active workspace. No changes were applied.`,
      409,
      false,
    );
  }
  const known = new Set(listFeatures(db).map((f) => f.key));
  const unknown = [...enable, ...disable].filter((f) => !known.has(f));
  if (unknown.length) {
    throw new ServiceError('UNKNOWN_FEATURE', `Unknown feature keys: ${unknown.join(', ')}.`, 400, false, { unknown });
  }
  const overlap = enable.filter((f) => disable.includes(f));
  if (overlap.length) {
    throw new ServiceError('CONFLICTING_CHANGES', `Features both enabled and disabled: ${overlap.join(', ')}.`, 400);
  }
  const sub = getSubscription(db, ws.customer_id);
  const allowed = getPlan(db, sub.plan_id).entitlements;
  const notAllowed = enable.filter((f) => !allowed.includes(f));
  if (notAllowed.length) {
    throw new ServiceError(
      'ENTITLEMENT_NOT_IN_PLAN',
      `Cannot enable ${notAllowed.join(', ')}: not included in the customer's current plan '${sub.plan_id}'. No changes were applied.`,
      403,
      false,
      { not_allowed: notAllowed, current_plan: sub.plan_id },
    );
  }

  const before = getEnabledFeatures(db, workspaceId);
  const ts = nowIso();
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO entitlements (workspace_id, feature, enabled_at) VALUES (?, ?, ?)');
    const del = db.prepare('DELETE FROM entitlements WHERE workspace_id = ? AND feature = ?');
    for (const f of enable) ins.run(workspaceId, f, ts);
    for (const f of disable) del.run(workspaceId, f);
  })();
  const after = getEnabledFeatures(db, workspaceId);
  return {
    workspace_id: workspaceId,
    enabled_now: after.filter((f) => !before.includes(f)),
    disabled_now: before.filter((f) => !after.includes(f)),
    enabled_entitlements: after,
  };
}

export function reactivateWorkspace(db: DB, workspaceId: string) {
  const ws = loadWorkspace(db, workspaceId);
  if (ws.status === 'active') return { changed: false, workspace: getWorkspace(db, workspaceId) };
  const sub = getSubscription(db, ws.customer_id);
  if (sub.status !== 'active') {
    throw new ServiceError(
      'SUBSCRIPTION_NOT_IN_GOOD_STANDING',
      `Cannot reactivate: customer subscription status is '${sub.status}'.`,
      409,
    );
  }
  db.prepare("UPDATE workspaces SET status = 'active', status_reason = NULL WHERE id = ?").run(workspaceId);
  return { changed: true, workspace: getWorkspace(db, workspaceId) };
}
