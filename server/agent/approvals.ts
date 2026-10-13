import crypto from 'node:crypto';
import { nowIso, type DB } from '../db/database.js';
import { getCustomer, getPlan, getSubscription } from '../systems/billing/service.js';
import { actionSignature } from './redact.js';

export interface Approval {
  id: string;
  run_id: string;
  tool: string;
  args: Record<string, unknown>;
  call_id: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  decided_at: string | null;
}

/**
 * Deterministic approval policy (company rule R3). The LLM cannot see or change
 * this code; it can only observe that an action was paused, approved or rejected.
 * Returns a human-readable reason when approval is required, otherwise null.
 */
export function approvalRequirement(db: DB, tool: string, args: Record<string, any>): string | null {
  if (tool === 'change_subscription') {
    try {
      const current = getSubscription(db, args.customer_id);
      const target = getPlan(db, args.plan_id);
      if (target.rank < current.plan_rank) {
        const name = getCustomer(db, args.customer_id).name;
        return `Downgrade of ${name} from ${current.plan_name} to ${target.name} (rule R3: downgrades require human approval).`;
      }
    } catch {
      return null; // invalid ids: let the tool itself return the proper error
    }
  }
  return null;
}

export class ApprovalManager {
  constructor(private db: DB) {}

  request(runId: string, tool: string, args: Record<string, unknown>, callId: string | null, reason: string): Approval {
    const id = `apr_${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, tool, args, call_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, runId, tool, JSON.stringify(args), callId, reason, nowIso());
    return this.get(id)!;
  }

  get(id: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? ({ ...r, args: JSON.parse(r.args) } as Approval) : null;
  }

  pendingForRun(runId: string): Approval | null {
    const r = this.db.prepare(`SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`).get(runId) as
      | { id: string }
      | undefined;
    return r ? this.get(r.id) : null;
  }

  listForRun(runId: string): Approval[] {
    const rows = this.db.prepare('SELECT id FROM approvals WHERE run_id = ? ORDER BY created_at').all(runId) as { id: string }[];
    return rows.map((r) => this.get(r.id)!);
  }

  decide(id: string, decision: 'approved' | 'rejected'): Approval {
    const res = this.db
      .prepare(`UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(decision, nowIso(), id);
    if (res.changes === 0) throw new Error(`Approval ${id} is not pending`);
    return this.get(id)!;
  }

  /** True if a human already rejected this exact action in this run (it must never be executed). */
  wasRejected(runId: string, tool: string, args: Record<string, unknown>): boolean {
    const rows = this.db
      .prepare(`SELECT args FROM approvals WHERE run_id = ? AND tool = ? AND status = 'rejected'`)
      .all(runId, tool) as { args: string }[];
    const sig = actionSignature(tool, args);
    return rows.some((r) => actionSignature(tool, JSON.parse(r.args)) === sig);
  }
}
