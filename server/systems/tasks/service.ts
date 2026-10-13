import crypto from 'node:crypto';
import { nowIso, type DB } from '../../db/database.js';
import { ServiceError } from '../errors.js';

export const TASK_TYPES = ['onboarding', 'transition', 'general'] as const;
export const TEAMS = ['customer_success', 'account_management', 'support'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskRow {
  id: string;
  customer_id: string;
  type: TaskType;
  title: string;
  description: string;
  team: string;
  status: string;
  run_id: string | null;
  created_at: string;
}

export function listTasks(db: DB, customerId?: string): TaskRow[] {
  return (
    customerId
      ? db.prepare('SELECT * FROM tasks WHERE customer_id = ? ORDER BY created_at').all(customerId)
      : db.prepare('SELECT * FROM tasks ORDER BY created_at').all()
  ) as TaskRow[];
}

/**
 * Create a task. Duplicate protection: if an *open* task of the same type
 * already exists for the customer with the same title, return it instead of
 * creating a second one.
 */
export function createTask(
  db: DB,
  input: { customer_id: string; type: TaskType; title: string; description: string; team: string },
  runId?: string,
) {
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(input.customer_id);
  if (!exists) throw new ServiceError('CUSTOMER_NOT_FOUND', `No customer with id '${input.customer_id}'.`, 404);

  const dup = db
    .prepare("SELECT * FROM tasks WHERE customer_id = ? AND type = ? AND lower(title) = lower(?) AND status = 'open'")
    .get(input.customer_id, input.type, input.title.trim()) as TaskRow | undefined;
  if (dup) return { created: false, message: 'An identical open task already exists.', task: dup };

  const task: TaskRow = {
    id: `task_${crypto.randomUUID().slice(0, 8)}`,
    customer_id: input.customer_id,
    type: input.type,
    title: input.title.trim(),
    description: input.description,
    team: input.team,
    status: 'open',
    run_id: runId ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    'INSERT INTO tasks (id, customer_id, type, title, description, team, status, run_id, created_at) VALUES (@id, @customer_id, @type, @title, @description, @team, @status, @run_id, @created_at)',
  ).run(task);
  return { created: true, task };
}
