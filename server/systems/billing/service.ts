import { nowIso, type DB } from '../../db/database.js';
import { ServiceError } from '../errors.js';

export interface Plan {
  id: string;
  name: string;
  rank: number;
  monthly_price: number;
  entitlements: string[];
}

export function listPlans(db: DB): Plan[] {
  const rows = db.prepare('SELECT * FROM plans ORDER BY rank').all() as (Omit<Plan, 'entitlements'> & { entitlements: string })[];
  return rows.map((r) => ({ ...r, entitlements: JSON.parse(r.entitlements) }));
}

export function getPlan(db: DB, planId: string): Plan {
  const plan = listPlans(db).find((p) => p.id === planId);
  if (!plan) throw new ServiceError('PLAN_NOT_FOUND', `No plan with id '${planId}'. Use the plan catalog for valid ids.`, 404);
  return plan;
}

export function listCustomers(db: DB, search?: string) {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, s.plan_id, s.status AS subscription_status
       FROM customers c JOIN subscriptions s ON s.customer_id = c.id ORDER BY c.name`,
    )
    .all() as { id: string; name: string; plan_id: string; subscription_status: string }[];
  if (!search) return rows;
  const q = search.toLowerCase();
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
}

export function getCustomer(db: DB, customerId: string) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as
    | { id: string; name: string; contact_email: string; account_owner: string }
    | undefined;
  if (!c) throw new ServiceError('CUSTOMER_NOT_FOUND', `No customer with id '${customerId}'.`, 404);
  const workspaces = db.prepare('SELECT id, name, status FROM workspaces WHERE customer_id = ?').all(customerId);
  return { ...c, subscription: getSubscription(db, customerId), workspaces };
}

export function getSubscription(db: DB, customerId: string) {
  const s = db.prepare('SELECT * FROM subscriptions WHERE customer_id = ?').get(customerId) as
    | { customer_id: string; plan_id: string; status: string; updated_at: string }
    | undefined;
  if (!s) throw new ServiceError('SUBSCRIPTION_NOT_FOUND', `Customer '${customerId}' has no subscription.`, 404);
  const plan = getPlan(db, s.plan_id);
  return { ...s, plan_name: plan.name, plan_rank: plan.rank, monthly_price: plan.monthly_price };
}

/**
 * Change a customer's plan. Approval for downgrades is enforced one level up
 * (approval manager) before this is called by the agent; the service itself
 * only enforces data integrity.
 */
export function changeSubscription(db: DB, customerId: string, planId: string, reason: string, runId?: string) {
  const current = getSubscription(db, customerId);
  const target = getPlan(db, planId);
  if (current.status === 'cancelled') {
    throw new ServiceError('SUBSCRIPTION_CANCELLED', 'Cancelled subscriptions cannot be changed.', 409);
  }
  if (current.plan_id === target.id) {
    return { changed: false, message: `Customer is already on ${target.name}.`, subscription: current };
  }
  const ts = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE subscriptions SET plan_id = ?, updated_at = ? WHERE customer_id = ?').run(target.id, ts, customerId);
    db.prepare(
      'INSERT INTO subscription_changes (customer_id, from_plan, to_plan, reason, run_id, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(customerId, current.plan_id, target.id, reason, runId ?? null, ts);
  })();
  return {
    changed: true,
    direction: target.rank > current.plan_rank ? 'upgrade' : 'downgrade',
    from_plan: current.plan_id,
    to_plan: target.id,
    subscription: getSubscription(db, customerId),
  };
}

export function isDowngrade(db: DB, customerId: string, planId: string): boolean {
  const current = getSubscription(db, customerId);
  const target = getPlan(db, planId);
  return target.rank < current.plan_rank;
}
