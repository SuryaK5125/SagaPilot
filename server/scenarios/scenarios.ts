/**
 * Demo scenarios and their acceptance conditions.
 *
 * These fixtures are used ONLY by the verifier and the dashboard. The agent
 * never sees them: it receives just the natural-language goal.
 */

export type Check =
  | { kind: 'subscription_plan'; customerId: string; planId: string }
  | { kind: 'entitlements_include'; workspaceId: string; features: string[] }
  | { kind: 'entitlements_exclude'; workspaceId: string; features: string[] }
  | { kind: 'workspace_active'; workspaceId: string }
  | { kind: 'task_created_in_run'; customerId: string; taskType: string; team: string }
  | { kind: 'no_duplicate_tasks_in_run'; customerId: string; taskType: string };

export interface Scenario {
  id: string;
  title: string;
  goal: string;
  checks: Check[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'upgrade',
    title: 'Scenario A — Upgrade Acme Corp',
    goal: 'Upgrade Acme Corp to Enterprise, enable the appropriate premium access, and create the required onboarding task.',
    checks: [
      { kind: 'subscription_plan', customerId: 'cus_acme', planId: 'enterprise' },
      {
        kind: 'entitlements_include',
        workspaceId: 'ws_acme',
        features: ['basic_reporting', 'api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support'],
      },
      { kind: 'workspace_active', workspaceId: 'ws_acme' },
      { kind: 'task_created_in_run', customerId: 'cus_acme', taskType: 'onboarding', team: 'customer_success' },
      { kind: 'no_duplicate_tasks_in_run', customerId: 'cus_acme', taskType: 'onboarding' },
    ],
  },
  {
    id: 'downgrade',
    title: 'Scenario B — Downgrade Beacon Labs',
    goal: 'Downgrade Beacon Labs to Starter, remove access no longer allowed under that plan, and create a transition task.',
    checks: [
      { kind: 'subscription_plan', customerId: 'cus_beacon', planId: 'starter' },
      {
        kind: 'entitlements_exclude',
        workspaceId: 'ws_beacon',
        features: ['api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support'],
      },
      // Removing *everything* would also be wrong: Starter access must stay.
      { kind: 'entitlements_include', workspaceId: 'ws_beacon', features: ['basic_reporting'] },
      { kind: 'task_created_in_run', customerId: 'cus_beacon', taskType: 'transition', team: 'account_management' },
      { kind: 'no_duplicate_tasks_in_run', customerId: 'cus_beacon', taskType: 'transition' },
    ],
  },
];

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A run is verifiable if it was started from a scenario or its goal text matches one exactly. */
export function findScenario(scenarioId: string | null | undefined, goal: string): Scenario | undefined {
  if (scenarioId) {
    const byId = SCENARIOS.find((s) => s.id === scenarioId);
    if (byId && normalize(byId.goal) === normalize(goal)) return byId;
  }
  return SCENARIOS.find((s) => normalize(s.goal) === normalize(goal));
}
