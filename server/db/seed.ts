import type { DB } from './database.js';

/**
 * Deterministic synthetic seed data. All names and emails are fictional.
 * Calling resetDatabase() always produces exactly this state, so demos are reproducible.
 */

const SEED_TIME = '2026-01-01T09:00:00.000Z';

export const FEATURES = [
  { key: 'basic_reporting', description: 'Standard dashboards and CSV export' },
  { key: 'api_access', description: 'Public REST API access' },
  { key: 'advanced_analytics', description: 'Cohort analysis and custom reports' },
  { key: 'sso', description: 'SAML single sign-on' },
  { key: 'audit_logs', description: 'Immutable audit log of admin actions' },
  { key: 'priority_support', description: '24/7 priority support channel' },
];

export const PLANS = [
  { id: 'starter', name: 'Starter', rank: 1, monthly_price: 49, entitlements: ['basic_reporting'] },
  {
    id: 'growth',
    name: 'Growth',
    rank: 2,
    monthly_price: 199,
    entitlements: ['basic_reporting', 'api_access', 'advanced_analytics'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    rank: 3,
    monthly_price: 899,
    entitlements: ['basic_reporting', 'api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support'],
  },
];

const CUSTOMERS = [
  { id: 'cus_acme', name: 'Acme Corp', email: 'ops@acme.example', owner: 'Priya Raman', plan: 'growth', status: 'active' },
  { id: 'cus_beacon', name: 'Beacon Labs', email: 'it@beaconlabs.example', owner: 'Marcus Lee', plan: 'enterprise', status: 'active' },
  { id: 'cus_cobalt', name: 'Cobalt Systems', email: 'admin@cobalt.example', owner: 'Priya Raman', plan: 'starter', status: 'active' },
  { id: 'cus_delta', name: 'Delta Freight', email: 'tech@deltafreight.example', owner: 'Marcus Lee', plan: 'growth', status: 'past_due' },
];

const WORKSPACES = [
  { id: 'ws_acme', customer: 'cus_acme', name: 'Acme Production', status: 'active', reason: null, features: ['basic_reporting', 'api_access', 'advanced_analytics'] },
  { id: 'ws_beacon', customer: 'cus_beacon', name: 'Beacon Research', status: 'active', reason: null, features: ['basic_reporting', 'api_access', 'advanced_analytics', 'sso', 'audit_logs', 'priority_support'] },
  { id: 'ws_cobalt', customer: 'cus_cobalt', name: 'Cobalt Main', status: 'active', reason: null, features: ['basic_reporting'] },
  { id: 'ws_delta', customer: 'cus_delta', name: 'Delta Ops', status: 'suspended', reason: 'Invoice overdue', features: ['basic_reporting'] },
];

const TASKS = [
  { id: 'task_seed_1', customer: 'cus_acme', type: 'general', title: 'Quarterly business review', description: 'Review Q4 usage with Acme Corp.', team: 'customer_success', status: 'done' },
  { id: 'task_seed_2', customer: 'cus_beacon', type: 'general', title: 'Renewal check-in', description: 'Beacon Labs asked about cost reductions at renewal.', team: 'account_management', status: 'open' },
];

const BUSINESS_TABLES = [
  'entitlements', 'workspaces', 'features', 'tasks', 'subscription_changes', 'subscriptions', 'customers', 'plans',
];
const RUNTIME_TABLES = ['failure_injections', 'run_events', 'approvals', 'idempotency_keys', 'runs'];

/** Wipe every table and re-insert the seed data inside one transaction. */
export function resetDatabase(db: DB): void {
  const tx = db.transaction(() => {
    for (const t of [...RUNTIME_TABLES, ...BUSINESS_TABLES]) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence`).run();

    const insFeature = db.prepare('INSERT INTO features (key, description) VALUES (?, ?)');
    for (const f of FEATURES) insFeature.run(f.key, f.description);

    const insPlan = db.prepare('INSERT INTO plans (id, name, rank, monthly_price, entitlements) VALUES (?, ?, ?, ?, ?)');
    for (const p of PLANS) insPlan.run(p.id, p.name, p.rank, p.monthly_price, JSON.stringify(p.entitlements));

    const insCustomer = db.prepare('INSERT INTO customers (id, name, contact_email, account_owner) VALUES (?, ?, ?, ?)');
    const insSub = db.prepare('INSERT INTO subscriptions (customer_id, plan_id, status, updated_at) VALUES (?, ?, ?, ?)');
    for (const c of CUSTOMERS) {
      insCustomer.run(c.id, c.name, c.email, c.owner);
      insSub.run(c.id, c.plan, c.status, SEED_TIME);
    }

    const insWs = db.prepare('INSERT INTO workspaces (id, customer_id, name, status, status_reason) VALUES (?, ?, ?, ?, ?)');
    const insEnt = db.prepare('INSERT INTO entitlements (workspace_id, feature, enabled_at) VALUES (?, ?, ?)');
    for (const w of WORKSPACES) {
      insWs.run(w.id, w.customer, w.name, w.status, w.reason);
      for (const f of w.features) insEnt.run(w.id, f, SEED_TIME);
    }

    const insTask = db.prepare(
      'INSERT INTO tasks (id, customer_id, type, title, description, team, status, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    );
    for (const t of TASKS) insTask.run(t.id, t.customer, t.type, t.title, t.description, t.team, t.status, SEED_TIME);
  });
  tx();
}

/** Seed only when the database is empty (first start). */
export function seedIfEmpty(db: DB): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM plans').get() as { n: number };
  if (row.n === 0) resetDatabase(db);
}
