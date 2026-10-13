import { describe, expect, it } from 'vitest';
import { ToolExecutor, MAX_FAILED_ATTEMPTS_PER_ACTION } from '../server/agent/executor.js';
import { RunStore } from '../server/agent/runStore.js';
import { ApprovalManager } from '../server/agent/approvals.js';
import { toolDeclarations } from '../server/agent/tools.js';
import { injectFailure } from '../server/systems/failures.js';
import * as billing from '../server/systems/billing/service.js';
import * as tasks from '../server/systems/tasks/service.js';
import { freshDb } from './helpers.js';

function setup() {
  const db = freshDb();
  const store = new RunStore(db);
  const run = store.create('test goal', null, 'test');
  return { db, store, exec: new ToolExecutor(db, store), runId: run.id, approvals: new ApprovalManager(db) };
}

describe('read tools return real database state', () => {
  it('list_customers / get_customer / get_plan_catalog / get_workspace', () => {
    const { exec, runId } = setup();
    const list = exec.execute(runId, { name: 'list_customers', args: { search: 'acme' } });
    expect(list).toMatchObject({ status: 'ok', data: { customers: [{ id: 'cus_acme', plan_id: 'growth' }] } });

    const cust = exec.execute(runId, { name: 'get_customer', args: { customer_id: 'cus_acme' } });
    expect(cust.status === 'ok' && (cust.data as any).workspaces[0].id).toBe('ws_acme');

    const cat = exec.execute(runId, { name: 'get_plan_catalog', args: {} });
    expect(cat.status === 'ok' && (cat.data as any).plans).toHaveLength(3);

    const ws = exec.execute(runId, { name: 'get_workspace', args: { workspace_id: 'ws_beacon' } });
    expect(ws.status === 'ok' && (ws.data as any).enabled_entitlements).toHaveLength(6);
  });
});

describe('mutation tools change real records', () => {
  it('change_subscription (upgrade), set_entitlements, create_task', () => {
    const { db, exec, runId } = setup();
    expect(exec.execute(runId, { name: 'change_subscription', args: { customer_id: 'cus_acme', plan_id: 'enterprise', reason: 'upgrade' } }).status).toBe('ok');
    expect(billing.getSubscription(db, 'cus_acme').plan_id).toBe('enterprise');

    expect(exec.execute(runId, { name: 'set_entitlements', args: { workspace_id: 'ws_acme', enable: ['sso', 'audit_logs'] } }).status).toBe('ok');
    const ws = exec.execute(runId, { name: 'get_workspace', args: { workspace_id: 'ws_acme' } });
    expect((ws as any).data.enabled_entitlements).toEqual(expect.arrayContaining(['sso', 'audit_logs']));

    const t = exec.execute(runId, { name: 'create_task', args: { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'Enterprise onboarding', description: 'Kickoff' } });
    expect(t.status).toBe('ok');
    expect(tasks.listTasks(db, 'cus_acme').find((x) => x.type === 'onboarding')?.run_id).toBe(runId);
  });
});

describe('invalid tool calls', () => {
  it('rejects unknown tools', () => {
    const { exec, runId } = setup();
    expect(exec.execute(runId, { name: 'run_sql', args: { q: 'DROP TABLE customers' } })).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_TOOL' } });
  });

  it('rejects missing, wrong-typed and extra arguments without touching the DB', () => {
    const { db, exec, runId } = setup();
    expect(exec.execute(runId, { name: 'get_customer', args: {} })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
    expect(exec.execute(runId, { name: 'set_entitlements', args: { workspace_id: 'ws_acme', enable: 'sso' } })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
    expect(exec.execute(runId, { name: 'set_entitlements', args: { workspace_id: 'ws_acme' } })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
    expect(exec.execute(runId, { name: 'create_task', args: { customer_id: 'cus_acme', type: 'party', team: 'support', title: 'abc', description: 'abc' } })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
    expect(exec.execute(runId, { name: 'get_subscription', args: { customer_id: 'cus_acme', sql: 'x' } })).toMatchObject({ error: { code: 'INVALID_ARGUMENTS' } });
    expect(tasks.listTasks(db)).toHaveLength(2);
  });

  it('exposes JSON-schema declarations for every tool', () => {
    const decls = toolDeclarations();
    expect(decls.find((d) => d.name === 'create_task')?.parametersJsonSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['customer_id', 'type']) });
  });
});

describe('idempotency', () => {
  it('replays an identical successful mutation instead of re-executing it', () => {
    const { db, exec, runId } = setup();
    const args = { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'Onboard', description: 'Details' };
    const a = exec.execute(runId, { name: 'create_task', args });
    const b = exec.execute(runId, { name: 'create_task', args });
    expect(a.status).toBe('ok');
    expect(b).toMatchObject({ status: 'ok', replayed: true });
    expect(tasks.listTasks(db, 'cus_acme').filter((t) => t.type === 'onboarding')).toHaveLength(1);

    // Rewording the free-text reason does not create a second subscription change either.
    exec.execute(runId, { name: 'change_subscription', args: { customer_id: 'cus_acme', plan_id: 'enterprise', reason: 'first' } });
    const again = exec.execute(runId, { name: 'change_subscription', args: { customer_id: 'cus_acme', plan_id: 'enterprise', reason: 'second wording' } });
    expect(again).toMatchObject({ status: 'ok', replayed: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscription_changes').get()).toEqual({ n: 1 });
  });

  it('does not cache failures, so a transient error can be retried', () => {
    const { db, exec, runId } = setup();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't');
    injectFailure(db, 'access.set_entitlements', 'transient_503');
    const call = { name: 'set_entitlements', args: { workspace_id: 'ws_acme', enable: ['sso'] } };
    expect(exec.execute(runId, call)).toMatchObject({ status: 'error', error: { code: 'SERVICE_UNAVAILABLE', retryable: true } });
    expect(exec.execute(runId, call)).toMatchObject({ status: 'ok' });
  });

  it('caps repeated failing attempts of the same action', () => {
    const { db, exec, runId } = setup();
    billing.changeSubscription(db, 'cus_acme', 'enterprise', 't');
    injectFailure(db, 'access.set_entitlements', 'transient_503', 5);
    const call = { name: 'set_entitlements', args: { workspace_id: 'ws_acme', enable: ['sso'] } };
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_ACTION; i++) expect(exec.execute(runId, call).status).toBe('error');
    expect(exec.execute(runId, call)).toMatchObject({ error: { code: 'RETRY_LIMIT_REACHED' } });
  });
});

describe('approval enforcement', () => {
  it('pauses a downgrade for approval and does not execute it', () => {
    const { db, exec, runId } = setup();
    const out = exec.execute(runId, { name: 'change_subscription', args: { customer_id: 'cus_beacon', plan_id: 'starter', reason: 'cost' } });
    expect(out.status).toBe('approval_required');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('enterprise');
  });

  it('upgrades do not need approval', () => {
    const { exec, runId } = setup();
    expect(exec.execute(runId, { name: 'change_subscription', args: { customer_id: 'cus_acme', plan_id: 'enterprise', reason: 'expansion' } }).status).toBe('ok');
  });

  it('executes only after approval, and never after rejection', () => {
    const { db, exec, runId, approvals } = setup();
    const call = { name: 'change_subscription', args: { customer_id: 'cus_beacon', plan_id: 'starter', reason: 'cost' } };
    const out = exec.execute(runId, call);
    if (out.status !== 'approval_required') throw new Error('expected approval');
    const rejected = approvals.decide(out.approval.id, 'rejected');
    expect(rejected.status).toBe('rejected');
    // The model tries again with different wording: still blocked.
    expect(exec.execute(runId, { ...call, args: { ...call.args, reason: 'please' } })).toMatchObject({ error: { code: 'REJECTED_BY_HUMAN' } });
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('enterprise');

    const run2 = new RunStore(db).create('g', null, 't').id;
    const out2 = exec.execute(run2, call);
    if (out2.status !== 'approval_required') throw new Error('expected approval');
    const approved = approvals.decide(out2.approval.id, 'approved');
    expect(exec.execute(run2, call, approved).status).toBe('ok');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('starter');
  });
});
