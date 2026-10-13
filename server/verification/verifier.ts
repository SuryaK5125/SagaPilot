import type { DB } from '../db/database.js';
import { findScenario, type Check } from '../scenarios/scenarios.js';

export interface CheckResult {
  description: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface VerificationReport {
  verifiable: boolean;
  scenario_id: string | null;
  passed: boolean;
  summary: string;
  checks: CheckResult[];
  /** Company-wide invariants, checked for every run (informational for unverifiable goals). */
  invariants: CheckResult[];
  verified_at: string;
}

/**
 * Independent outcome verifier.
 *
 * It reads the database directly with its own SQL; it does not use the agent's
 * tools, its conversation, or its final message. A run is "completed and
 * verified" only if every check passes against the real records.
 */
export function verifyRun(db: DB, run: { id: string; goal: string; scenario_id: string | null }): VerificationReport {
  const scenario = findScenario(run.scenario_id, run.goal);
  const invariants = checkInvariants(db);
  const verified_at = new Date().toISOString();

  if (!scenario) {
    return {
      verifiable: false,
      scenario_id: null,
      passed: false,
      summary: 'No acceptance conditions are defined for this goal, so completion cannot be independently verified.',
      checks: [],
      invariants,
      verified_at,
    };
  }

  const checks = scenario.checks.map((c) => runCheck(db, run.id, c));
  const passed = checks.every((c) => c.passed);
  const failed = checks.filter((c) => !c.passed).length;
  return {
    verifiable: true,
    scenario_id: scenario.id,
    passed,
    summary: passed ? `All ${checks.length} checks passed.` : `${failed} of ${checks.length} checks failed.`,
    checks,
    invariants,
    verified_at,
  };
}

function enabledFeatures(db: DB, workspaceId: string): string[] {
  return (db.prepare('SELECT feature FROM entitlements WHERE workspace_id = ? ORDER BY feature').all(workspaceId) as { feature: string }[]).map(
    (r) => r.feature,
  );
}

export function runCheck(db: DB, runId: string, c: Check): CheckResult {
  switch (c.kind) {
    case 'subscription_plan': {
      const row = db.prepare('SELECT plan_id FROM subscriptions WHERE customer_id = ?').get(c.customerId) as { plan_id: string } | undefined;
      return { description: `${c.customerId} subscription is '${c.planId}'`, passed: row?.plan_id === c.planId, expected: c.planId, actual: row?.plan_id ?? null };
    }
    case 'entitlements_include': {
      const actual = enabledFeatures(db, c.workspaceId);
      const missing = c.features.filter((f) => !actual.includes(f));
      return { description: `${c.workspaceId} has entitlements ${c.features.join(', ')}`, passed: missing.length === 0, expected: c.features, actual: missing.length ? { enabled: actual, missing } : actual };
    }
    case 'entitlements_exclude': {
      const actual = enabledFeatures(db, c.workspaceId);
      const present = c.features.filter((f) => actual.includes(f));
      return { description: `${c.workspaceId} no longer has ${c.features.join(', ')}`, passed: present.length === 0, expected: 'none of these enabled', actual: present.length ? { enabled: actual, still_present: present } : actual };
    }
    case 'workspace_active': {
      const row = db.prepare('SELECT status FROM workspaces WHERE id = ?').get(c.workspaceId) as { status: string } | undefined;
      return { description: `${c.workspaceId} is active`, passed: row?.status === 'active', expected: 'active', actual: row?.status ?? null };
    }
    case 'task_created_in_run': {
      const rows = db
        .prepare(`SELECT id, title, team, status FROM tasks WHERE customer_id = ? AND type = ? AND run_id = ?`)
        .all(c.customerId, c.taskType, runId) as { id: string; title: string; team: string; status: string }[];
      const ok = rows.some((r) => r.team === c.team && r.status === 'open');
      return { description: `Open '${c.taskType}' task for ${c.customerId} owned by ${c.team} created by this run`, passed: ok, expected: { type: c.taskType, team: c.team, status: 'open' }, actual: rows };
    }
    case 'no_duplicate_tasks_in_run': {
      const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ? AND type = ? AND run_id = ?').get(c.customerId, c.taskType, runId) as { n: number };
      return { description: `At most one '${c.taskType}' task for ${c.customerId} created by this run`, passed: row.n <= 1, expected: '<= 1', actual: row.n };
    }
  }
}

/** Rule R1 holds for every workspace: no entitlement outside the customer's plan. */
function checkInvariants(db: DB): CheckResult[] {
  const rows = db
    .prepare(
      `SELECT w.id AS workspace_id, p.entitlements AS allowed
       FROM workspaces w JOIN subscriptions s ON s.customer_id = w.customer_id JOIN plans p ON p.id = s.plan_id ORDER BY w.id`,
    )
    .all() as { workspace_id: string; allowed: string }[];
  return rows.map((r) => {
    const allowed: string[] = JSON.parse(r.allowed);
    const outside = enabledFeatures(db, r.workspace_id).filter((f) => !allowed.includes(f));
    return { description: `${r.workspace_id} has no entitlements outside its plan`, passed: outside.length === 0, expected: [], actual: outside };
  });
}
