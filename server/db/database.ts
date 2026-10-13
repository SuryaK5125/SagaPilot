import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * One SQLite database holds all three simulated systems (billing, access, tasks)
 * plus the agent's own bookkeeping (runs, events, approvals, idempotency keys).
 */
const SCHEMA = `
-- ---------- Billing ----------
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  rank          INTEGER NOT NULL,          -- higher = more premium; used to detect downgrades
  monthly_price INTEGER NOT NULL,
  entitlements  TEXT NOT NULL               -- JSON array of feature keys included in the plan
);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  account_owner TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  customer_id   TEXT PRIMARY KEY REFERENCES customers(id),
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  status        TEXT NOT NULL,              -- active | past_due | cancelled
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL,
  from_plan     TEXT NOT NULL,
  to_plan       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  run_id        TEXT,
  changed_at    TEXT NOT NULL
);

-- ---------- Access management ----------
CREATE TABLE IF NOT EXISTS features (
  key           TEXT PRIMARY KEY,
  description   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,             -- active | suspended
  status_reason  TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  feature       TEXT NOT NULL REFERENCES features(key),
  enabled_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, feature)
);

-- ---------- Task management ----------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,              -- onboarding | transition | general
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  team          TEXT NOT NULL,
  status        TEXT NOT NULL,              -- open | done
  run_id        TEXT,
  created_at    TEXT NOT NULL
);

-- ---------- Simulated environment: failure injection ----------
CREATE TABLE IF NOT EXISTS failure_injections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation     TEXT NOT NULL,              -- e.g. access.set_entitlements
  kind          TEXT NOT NULL,              -- transient_503 | workspace_suspended
  remaining     INTEGER NOT NULL,           -- how many more times it fires
  created_at    TEXT NOT NULL
);

-- ---------- Agent runtime bookkeeping ----------
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  scenario_id   TEXT,
  status        TEXT NOT NULL,              -- running | awaiting_approval | completed_verified | completed_unverified | incomplete | failed
  model         TEXT NOT NULL,
  step_count    INTEGER NOT NULL DEFAULT 0,
  history       TEXT NOT NULL DEFAULT '[]', -- Gemini conversation contents (JSON), needed to resume after approval
  pending       TEXT,                       -- JSON: function responses collected while waiting for approval
  final_message TEXT,
  verification  TEXT,                       -- JSON verifier report
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args          TEXT NOT NULL,
  call_id       TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL,              -- pending | approved | rejected
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  result        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`;

export function openDatabase(file: string = ':memory:'): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();
