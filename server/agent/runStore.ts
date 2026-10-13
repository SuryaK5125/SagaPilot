import crypto from 'node:crypto';
import type { Content } from '@google/genai';
import { nowIso, type DB } from '../db/database.js';

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed_verified'
  | 'completed_unverified'
  | 'incomplete'
  | 'failed';

export const TERMINAL_STATUSES: RunStatus[] = ['completed_verified', 'completed_unverified', 'incomplete', 'failed'];

/** Function responses gathered for a model turn that was paused for approval. */
export interface PendingTurn {
  parts: unknown[]; // Gemini Part objects; parts[approvalIndex] is filled in once a human decides
  approvalIndex: number;
  approvalId: string;
}

export interface Run {
  id: string;
  goal: string;
  scenario_id: string | null;
  status: RunStatus;
  model: string;
  step_count: number;
  history: Content[];
  pending: PendingTurn | null;
  final_message: string | null;
  verification: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  id: number;
  run_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Persistence for runs and their execution trace. Everything is in SQLite so a run can resume after approval. */
export class RunStore {
  constructor(private db: DB) {}

  create(goal: string, scenarioId: string | null, model: string): Run {
    const id = `run_${crypto.randomUUID().slice(0, 8)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, goal, scenario_id, status, model, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, goal, scenarioId, model, ts, ts);
    return this.get(id)!;
  }

  get(id: string): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!r) return null;
    return {
      ...r,
      history: JSON.parse(r.history),
      pending: r.pending ? JSON.parse(r.pending) : null,
      verification: r.verification ? JSON.parse(r.verification) : null,
    } as Run;
  }

  list(limit = 20) {
    return this.db
      .prepare('SELECT id, goal, scenario_id, status, step_count, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  update(id: string, patch: Partial<Omit<Run, 'id'>>) {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      vals.push(['history', 'pending', 'verification'].includes(k) ? (v == null ? null : JSON.stringify(v)) : v);
    }
    cols.push('updated_at = ?');
    vals.push(nowIso());
    this.db.prepare(`UPDATE runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  addEvent(runId: string, type: string, payload: Record<string, unknown>) {
    this.db
      .prepare('INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, type, JSON.stringify(payload), nowIso());
  }

  events(runId: string, afterId = 0): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id')
      .all(runId, afterId) as (Omit<RunEvent, 'payload'> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /** How many times this exact call (tool + args) has already failed in this run. */
  failedAttempts(runId: string, signature: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'tool_result'
         AND json_extract(payload, '$.signature') = ? AND json_extract(payload, '$.ok') = 0`,
      )
      .get(runId, signature) as { n: number };
    return row.n;
  }
}
