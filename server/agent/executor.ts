import crypto from 'node:crypto';
import { nowIso, type DB } from '../db/database.js';
import { ServiceError } from '../systems/errors.js';
import { TOOL_MAP, type ToolDef } from './tools.js';
import { ApprovalManager, approvalRequirement, type Approval } from './approvals.js';
import { RunStore } from './runStore.js';
import { actionSignature, redact } from './redact.js';

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  http_status?: number;
  details?: unknown;
}

export type ToolOutcome =
  | { status: 'ok'; data: unknown; replayed?: boolean }
  | { status: 'error'; error: ToolError }
  | { status: 'approval_required'; approval: Approval };

/** Same failing call (same tool + same effect) is executed at most this many times per run. */
export const MAX_FAILED_ATTEMPTS_PER_ACTION = 3;

/**
 * The tool executor is the only path from an LLM decision to a real side effect.
 * For every call it runs these deterministic guards, in order:
 *   1. tool exists            4. retry budget not exhausted
 *   2. arguments valid (Zod)  5. approval policy (mutations)
 *   3. not human-rejected     6. idempotency key (mutations)
 * then executes the real system operation and records the result in the trace.
 */
export class ToolExecutor {
  private approvals: ApprovalManager;

  constructor(
    private db: DB,
    private store: RunStore,
    private tools: Map<string, ToolDef> = TOOL_MAP,
  ) {
    this.approvals = new ApprovalManager(db);
  }

  /**
   * @param approved  set only when resuming an action a human has approved.
   */
  execute(runId: string, call: ToolCall, approved?: Approval): ToolOutcome {
    const args = call.args ?? {};
    const signature = actionSignature(call.name, args);
    this.store.addEvent(runId, 'tool_call', {
      tool: call.name,
      args: redact(args) as Record<string, unknown>,
      call_id: call.id ?? null,
      ...(approved ? { approval_id: approved.id } : {}),
    });

    const outcome = this.guardedExecute(runId, call, args, signature, approved);

    if (outcome.status === 'approval_required') {
      this.store.addEvent(runId, 'approval_requested', {
        tool: call.name,
        args: redact(args) as Record<string, unknown>,
        approval_id: outcome.approval.id,
        reason: outcome.approval.reason,
      });
    } else {
      this.store.addEvent(runId, 'tool_result', {
        tool: call.name,
        signature,
        ok: outcome.status === 'ok' ? 1 : 0,
        ...(outcome.status === 'ok'
          ? { data: redact(outcome.data), replayed: outcome.replayed ?? false }
          : { error: outcome.error }),
      });
    }
    return outcome;
  }

  private guardedExecute(
    runId: string,
    call: ToolCall,
    rawArgs: Record<string, unknown>,
    signature: string,
    approved?: Approval,
  ): ToolOutcome {
    // 1. Only registered tools can run.
    const tool = this.tools.get(call.name);
    if (!tool) {
      return err('UNKNOWN_TOOL', `There is no tool named '${call.name}'. Available: ${[...this.tools.keys()].join(', ')}`);
    }

    // 2. Never trust model-generated arguments.
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return err('INVALID_ARGUMENTS', 'Arguments failed validation.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const args = parsed.data as Record<string, unknown>;

    if (tool.kind === 'mutation') {
      // 3. A rejected action can never be executed later in the same run.
      if (this.approvals.wasRejected(runId, tool.name, args)) {
        return err('REJECTED_BY_HUMAN', 'A human reviewer already rejected this exact action in this run. It will not be executed.');
      }

      // 4. Bounded retries of the same failing action.
      const failures = this.store.failedAttempts(runId, signature);
      if (failures >= MAX_FAILED_ATTEMPTS_PER_ACTION) {
        return err(
          'RETRY_LIMIT_REACHED',
          `This exact action already failed ${failures} times in this run; it will not be attempted again.`,
        );
      }

      // 5. Deterministic approval policy. The model cannot skip this.
      if (!approved) {
        const reason = approvalRequirement(this.db, tool.name, args);
        if (reason) {
          return { status: 'approval_required', approval: this.approvals.request(runId, tool.name, args, call.id ?? null, reason) };
        }
      }

      // 6. Idempotency: an identical successful mutation in this run is replayed, not re-executed.
      const key = crypto.createHash('sha256').update(`${runId}|${signature}`).digest('hex');
      const prior = this.db.prepare('SELECT result FROM idempotency_keys WHERE key = ?').get(key) as { result: string } | undefined;
      if (prior) return { status: 'ok', data: JSON.parse(prior.result), replayed: true };

      const outcome = this.run(tool, runId, args);
      // Only successes are stored, so a failed attempt can still be retried.
      if (outcome.status === 'ok') {
        this.db
          .prepare('INSERT INTO idempotency_keys (key, tool, result, created_at) VALUES (?, ?, ?, ?)')
          .run(key, tool.name, JSON.stringify(outcome.data), nowIso());
      }
      return outcome;
    }

    return this.run(tool, runId, args);
  }

  private run(tool: ToolDef, runId: string, args: Record<string, unknown>): ToolOutcome {
    try {
      return { status: 'ok', data: tool.run({ db: this.db, runId }, args as never) };
    } catch (e) {
      if (e instanceof ServiceError) {
        return {
          status: 'error',
          error: { code: e.code, message: e.message, retryable: e.retryable, http_status: e.httpStatus, details: e.details },
        };
      }
      return err('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    }
  }
}

function err(code: string, message: string, details?: unknown): ToolOutcome {
  return { status: 'error', error: { code, message, retryable: false, ...(details ? { details } : {}) } };
}
