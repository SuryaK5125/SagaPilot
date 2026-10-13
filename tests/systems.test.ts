import { describe, expect, it } from 'vitest';
import { resetDatabase } from '../server/db/seed.js';
import * as billing from '../server/systems/billing/service.js';
import * as access from '../server/systems/access/service.js';
import * as tasks from '../server/systems/tasks/service.js';
import { injectFailure, listActiveFailures } from '../server/systems/failures.js';
import { ServiceError } from '../server/systems/errors.js';
import { freshDb } from './helpers.js';

describe('seed and reset', () => {
  it('seeds Acme on Growth and Beacon on Enterprise', () => {
    const db = freshDb();
    expect(billing.getSubscription(db, 'cus_acme').plan_id).toBe('growth');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('enterprise');
    expect(access.getEnabledFeatures(db, 'ws_beacon')).toHaveLength(6);
    expect(billing.listPlans(db).map((p) => p.id)).toEqual(['starter', 'growth', 'enterprise']);
  });

  it('reset restores the exact seed state after mutations', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 'test');
    access.setEntitlements(db, 'ws_acme', ['sso'], []);
    tasks.createTask(db, { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'x task', description: 'y' });
    injectFailure(db, 'access.set_entitlements', 'transient_503');

    resetDatabase(db);
    expect(billing.getSubscription(db, 'cus_acme').plan_id).toBe('growth');
    expect(access.getEnabledFeatures(db, 'ws_acme')).toEqual(['advanced_analytics', 'api_access', 'basic_reporting']);
    expect(tasks.listTasks(db, 'cus_acme')).toHaveLength(1);
    expect(listActiveFailures(db)).toEqual([]);
  });
});

describe('domain rules', () => {
  it('rejects enabling a feature that is not in the current plan', () => {
    const db = freshDb();
    expect(() => access.setEntitlements(db, 'ws_acme', ['sso'], [])).toThrowError(/not included in the customer's current plan/);
    expect(access.getEnabledFeatures(db, 'ws_acme')).not.toContain('sso');
  });

  it('rejects entitlement changes on a suspended workspace', () => {
    const db = freshDb();
    expect(() => access.setEntitlements(db, 'ws_delta', [], ['basic_reporting'])).toThrowError(ServiceError);
  });

  it('refuses to reactivate a workspace whose subscription is not active', () => {
    const db = freshDb();
    expect(() => access.reactivateWorkspace(db, 'ws_delta')).toThrowError(/past_due/);
  });

  it('records subscription changes in billing history', () => {
    const db = freshDb();
    const res = billing.changeSubscription(db, 'cus_acme', 'enterprise', 'customer request', 'run_x');
    expect(res).toMatchObject({ changed: true, direction: 'upgrade' });
    const rows = db.prepare('SELECT * FROM subscription_changes').all();
    expect(rows).toHaveLength(1);
  });
});

describe('failure injection', () => {
  it('transient_503 fails exactly once and applies no changes', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't');
    injectFailure(db, 'access.set_entitlements', 'transient_503');
    try {
      access.setEntitlements(db, 'ws_acme', ['sso'], []);
      expect.unreachable();
    } catch (e) {
      expect((e as ServiceError).httpStatus).toBe(503);
      expect((e as ServiceError).retryable).toBe(true);
    }
    expect(access.getEnabledFeatures(db, 'ws_acme')).not.toContain('sso');
    // Second attempt succeeds: the injection was consumed.
    expect(access.setEntitlements(db, 'ws_acme', ['sso'], []).enabled_now).toEqual(['sso']);
  });

  it('workspace_suspended suspends the workspace and needs a reactivation', () => {
    const db = freshDb();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't');
    injectFailure(db, 'access.set_entitlements', 'workspace_suspended');
    expect(() => access.setEntitlements(db, 'ws_acme', ['sso'], [])).toThrowError(/suspended/);
    expect(access.getWorkspace(db, 'ws_acme').status).toBe('suspended');
    // Retrying alone does not help; the precondition must be fixed.
    expect(() => access.setEntitlements(db, 'ws_acme', ['sso'], [])).toThrowError(/suspended/);
    access.reactivateWorkspace(db, 'ws_acme');
    expect(access.setEntitlements(db, 'ws_acme', ['sso'], []).enabled_now).toEqual(['sso']);
  });
});
