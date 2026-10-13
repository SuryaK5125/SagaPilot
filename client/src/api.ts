export interface Scenario { id: string; title: string; goal: string }
export interface Plan { id: string; name: string; rank: number; monthly_price: number; entitlements: string[] }
export interface Customer { id: string; name: string; plan_id: string; subscription_status: string }
export interface Workspace {
  id: string; customer_id: string; name: string; status: string; status_reason: string | null;
  customer_plan: string; enabled_entitlements: string[]; allowed_by_current_plan: string[]; enabled_but_not_in_plan: string[];
}
export interface Task { id: string; customer_id: string; type: string; title: string; team: string; status: string; run_id: string | null; created_at: string }
export interface Failure { id: number; operation: string; kind: string; remaining: number }
export interface SystemState { plans: Plan[]; customers: Customer[]; workspaces: Workspace[]; tasks: Task[]; failures: Failure[] }

export interface CheckResult { description: string; passed: boolean; expected: unknown; actual: unknown }
export interface Verification { verifiable: boolean; scenario_id: string | null; passed: boolean; summary: string; checks: CheckResult[]; invariants: CheckResult[] }
export interface RunEvent { id: number; type: string; payload: Record<string, any>; created_at: string }
export interface Approval { id: string; tool: string; args: Record<string, unknown>; reason: string; status: string }
export interface RunDetail {
  id: string; goal: string; scenario_id: string | null; status: string; model: string; step_count: number;
  final_message: string | null; verification: Verification | null; error: string | null; active: boolean;
  approvals: Approval[]; events: RunEvent[];
}
export interface Health { ok: boolean; model: string; agent_ready: boolean; agent_error: string | null }

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error?.code ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  health: () => req<Health>('GET', '/api/health'),
  scenarios: () => req<Scenario[]>('GET', '/api/scenarios'),
  state: () => req<SystemState>('GET', '/api/state'),
  reset: () => req('POST', '/api/reset'),
  injectFailure: (kind: string) => req('POST', '/api/failures', { operation: 'access.set_entitlements', kind }),
  clearFailures: () => req('DELETE', '/api/failures'),
  startRun: (goal: string, scenario_id?: string) => req<{ id: string }>('POST', '/api/runs', { goal, scenario_id }),
  runs: () => req<{ id: string; status: string }[]>('GET', '/api/runs'),
  run: (id: string) => req<RunDetail>('GET', `/api/runs/${id}`),
  decide: (approvalId: string, decision: 'approve' | 'reject') => req('POST', `/api/approvals/${approvalId}/${decision}`),
};
