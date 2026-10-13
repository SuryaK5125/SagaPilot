import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../server/agent/runner.js';
import { SCENARIOS } from '../server/scenarios/scenarios.js';
import { injectFailure } from '../server/systems/failures.js';
import * as billing from '../server/systems/billing/service.js';
import * as access from '../server/systems/access/service.js';
import { FakeModelAdapter, freshDb } from './helpers.js';

/*
 * These tests drive the runtime with a FakeModelAdapter (scripted decisions).
 * They check the loop mechanics: tool execution, observations fed back,
 * approval pause/resume, limits and verification. They do NOT test the LLM.
 */

const upgradeGoal = SCENARIOS[0].goal;
const downgradeGoal = SCENARIOS[1].goal;
const call = (name: string, args: Record<string, unknown> = {}) => [{ name, args }];

describe('agent loop (fake model)', () => {
  it('executes calls, feeds back a 503 observation, and completes verified after a retry', async () => {
    const db = freshDb();
    injectFailure(db, 'access.set_entitlements', 'transient_503');
    const seen: string[] = [];
    const model = new FakeModelAdapter(({ step, lastResults }) => {
      if (lastResults[0]?.error) seen.push((lastResults[0].error as any).code);
      const enable = { workspace_id: 'ws_acme', enable: ['sso', 'audit_logs', 'priority_support'] };
      switch (step) {
        case 1: return call('change_subscription', { customer_id: 'cus_acme', plan_id: 'enterprise', reason: 'upgrade' });
        case 2: return call('set_entitlements', enable); // gets the injected 503
        case 3: return call('set_entitlements', enable); // the "model" retries
        case 4: return call('create_task', { customer_id: 'cus_acme', type: 'onboarding', team: 'customer_success', title: 'Enterprise onboarding', description: 'Details' });
        default: return 'Done.';
      }
    });
    const runner = new AgentRunner(db, model);
    const run = await runner.startAndWait(upgradeGoal, 'upgrade');

    expect(seen).toEqual(['SERVICE_UNAVAILABLE']);
    expect(run.status).toBe('completed_verified');
    expect(run.step_count).toBe(5);
    const types = runner.store.events(run.id).map((e) => e.type);
    expect(types).toContain('verification');
    expect(model.requests[0].tools.length).toBeGreaterThan(5);
  });

  it('does not trust the model: a false "done" claim ends as incomplete', async () => {
    const db = freshDb();
    const runner = new AgentRunner(db, new FakeModelAdapter(() => 'I upgraded Acme Corp and everything is complete.'));
    const run = await runner.startAndWait(upgradeGoal, 'upgrade');
    expect(run.status).toBe('incomplete');
    expect((run.verification as any).passed).toBe(false);
  });

  it('pauses for downgrade approval, resumes after approval and verifies', async () => {
    const db = freshDb();
    const model = new FakeModelAdapter(({ step, lastResults }) => {
      if (step === 1) return call('change_subscription', { customer_id: 'cus_beacon', plan_id: 'starter', reason: 'cost' });
      if (step === 2) {
        expect(lastResults[0].human_decision).toBe('approved');
        return call('set_entitlements', { workspace_id: 'ws_beacon', disable: ['api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support'] });
      }
      if (step === 3) return call('create_task', { customer_id: 'cus_beacon', type: 'transition', team: 'account_management', title: 'Starter transition', description: 'Details' });
      return 'Done.';
    });
    const runner = new AgentRunner(db, model);
    let run = await runner.startAndWait(downgradeGoal, 'downgrade');
    expect(run.status).toBe('awaiting_approval');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('enterprise'); // not executed yet

    const approval = runner.approvals.pendingForRun(run.id)!;
    run = await runner.decide(approval.id, 'approved', true);
    expect(run.status).toBe('completed_verified');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('starter');
    expect(access.getEnabledFeatures(db, 'ws_beacon')).toEqual(['basic_reporting']);
  });

  it('never executes a rejected action and reports the run as incomplete', async () => {
    const db = freshDb();
    const model = new FakeModelAdapter(({ step, lastResults }) => {
      if (step === 1) return call('change_subscription', { customer_id: 'cus_beacon', plan_id: 'starter', reason: 'cost' });
      if (step === 2) {
        expect((lastResults[0].error as any).code).toBe('REJECTED_BY_HUMAN');
        // A misbehaving model retries anyway: the executor still blocks it.
        return call('change_subscription', { customer_id: 'cus_beacon', plan_id: 'starter', reason: 'really needed' });
      }
      return 'Downgrade was rejected; nothing changed.';
    });
    const runner = new AgentRunner(db, model);
    let run = await runner.startAndWait(downgradeGoal, 'downgrade');
    run = await runner.decide(runner.approvals.pendingForRun(run.id)!.id, 'rejected', true);
    expect(run.status).toBe('incomplete');
    expect(billing.getSubscription(db, 'cus_beacon').plan_id).toBe('enterprise');
    const errors = runner.store.events(run.id).filter((e) => e.type === 'tool_result' && e.payload.ok === 0);
    expect(errors.map((e) => (e.payload.error as any).code)).toContain('REJECTED_BY_HUMAN');
  });

  it('stops at the step limit instead of looping forever', async () => {
    const db = freshDb();
    const runner = new AgentRunner(db, new FakeModelAdapter(() => call('get_customer', { customer_id: 'cus_acme' })), { maxSteps: 4 });
    const run = await runner.startAndWait(upgradeGoal, 'upgrade');
    expect(run.status).toBe('incomplete');
    expect(run.step_count).toBe(4);
    expect(run.error).toMatch(/step limit/);
  });

  it('marks free-form goals as completed but unverified', async () => {
    const db = freshDb();
    const runner = new AgentRunner(db, new FakeModelAdapter(({ step }) => (step === 1 ? call('list_customers') : 'Listed customers.')));
    const run = await runner.startAndWait('Tell me which customers we have', null);
    expect(run.status).toBe('completed_unverified');
  });

  it('marks the run failed when the model call throws', async () => {
    const db = freshDb();
    const runner = new AgentRunner(db, { name: 'broken', generate: async () => { throw new Error('model down'); } });
    const run = await runner.startAndWait(upgradeGoal, 'upgrade');
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/model down/);
  });
});
