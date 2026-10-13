import { describe, expect, it } from 'vitest';
import { verifyRun } from '../server/verification/verifier.js';
import { SCENARIOS } from '../server/scenarios/scenarios.js';
import * as billing from '../server/systems/billing/service.js';
import * as access from '../server/systems/access/service.js';
import * as tasks from '../server/systems/tasks/service.js';
import { freshDb } from './helpers.js';

const upgrade = SCENARIOS.find((s) => s.id === 'upgrade')!;
const downgrade = SCENARIOS.find((s) => s.id === 'downgrade')!;

describe('verifier', () => {
  it('fails every upgrade check on the untouched seed state', () => {
    const db = freshDb();
    const r = verifyRun(db, { id: 'run_1', goal: upgrade.goal, scenario_id: 'upgrade' });
    expect(r.verifiable).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.description.includes('subscription'))?.passed).toBe(false);
  });

  it('detects a partially completed upgrade (plan changed, access + task missing)', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't', 'run_1');
    const r = verifyRun(db, { id: 'run_1', goal: upgrade.goal, scenario_id: 'upgrade' });
    expect(r.passed).toBe(false);
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.description);
    expect(failed.some((d) => d.includes('has entitlements'))).toBe(true);
    expect(failed.some((d) => d.includes('onboarding'))).toBe(true);
  });

  it('passes only when all records match, and requires the task to come from this run', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't', 'run_1');
    access.setEntitlements(db, 'ws_acme', ['sso', 'audit_logs', 'priority_support'], []);
    tasks.createTask(db, { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'Onboard', description: 'Details' }, 'run_other');
    expect(verifyRun(db, { id: 'run_1', goal: upgrade.goal, scenario_id: 'upgrade' }).passed).toBe(false);

    tasks.createTask(db, { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'Onboard 2', description: 'Details' }, 'run_1');
    const r = verifyRun(db, { id: 'run_1', goal: upgrade.goal, scenario_id: 'upgrade' });
    expect(r.passed).toBe(true);
  });

  it('downgrade fails if premium access is left enabled, and if ALL access is removed', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_beacon', 'starter', 't', 'run_2');
    tasks.createTask(db, { customer_id: 'cus_beacon', type: 'transition', team: 'account_management', title: 'Transition', description: 'Details' }, 'run_2');
    expect(verifyRun(db, { id: 'run_2', goal: downgrade.goal, scenario_id: 'downgrade' }).passed).toBe(false);

    access.setEntitlements(db, 'ws_beacon', [], ['api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support', 'basic_reporting']);
    expect(verifyRun(db, { id: 'run_2', goal: downgrade.goal, scenario_id: 'downgrade' }).passed).toBe(false);

    access.setEntitlements(db, 'ws_beacon', ['basic_reporting'], []);
    expect(verifyRun(db, { id: 'run_2', goal: downgrade.goal, scenario_id: 'downgrade' }).passed).toBe(true);
  });

  it('reports arbitrary goals as not verifiable instead of claiming success', () => {
    const db = freshDb();
    const r = verifyRun(db, { id: 'run_3', goal: 'Give Cobalt Systems API access', scenario_id: null });
    expect(r.verifiable).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/cannot be independently verified/);
  });
});
