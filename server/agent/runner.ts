import type { Content, Part } from '@google/genai';
import type { DB } from '../db/database.js';
import { verifyRun } from '../verification/verifier.js';
import { ApprovalManager } from './approvals.js';
import { ToolExecutor, type ToolOutcome } from './executor.js';
import type { ModelAdapter, ModelFunctionCall } from './model.js';
import { initialUserMessage, SYSTEM_INSTRUCTION } from './prompt.js';
import { redact } from './redact.js';
import { RunStore, type Run, type RunStatus } from './runStore.js';
import { toolDeclarations } from './tools.js';

export interface RunnerOptions {
  maxSteps?: number; // max model turns per run
  runTimeoutMs?: number; // wall-clock budget per run (excluding time waiting for a human)
}

/**
 * Agent runner: Goal → (model picks tool → executor runs it → observation back to model)* → final report → verifier.
 *
 * The runner never decides WHICH business action to take. It only:
 *  - sends the goal, tool declarations and the conversation so far to the model,
 *  - executes whatever tool calls the model returns (through the guarded executor),
 *  - feeds the real results back,
 *  - pauses for approval, enforces step/time limits, and runs the verifier at the end.
 */
export class AgentRunner {
  readonly store: RunStore;
  readonly approvals: ApprovalManager;
  private executor: ToolExecutor;
  private active = new Set<string>(); // runs whose loop is currently executing in this process
  private maxSteps: number;
  private runTimeoutMs: number;

  constructor(
    private db: DB,
    private model: ModelAdapter,
    opts: RunnerOptions = {},
  ) {
    this.store = new RunStore(db);
    this.approvals = new ApprovalManager(db);
    this.executor = new ToolExecutor(db, this.store);
    this.maxSteps = opts.maxSteps ?? 24;
    this.runTimeoutMs = opts.runTimeoutMs ?? 5 * 60_000;
  }

  /** Create a run and start its loop in the background. Returns immediately. */
  start(goal: string, scenarioId: string | null = null): Run {
    const id = this.createRun(goal, scenarioId);
    void this.loop(id);
    return this.store.get(id)!;
  }

  /** Start and wait until the run stops (finished or awaiting approval). Used by tests and the CLI. */
  async startAndWait(goal: string, scenarioId: string | null = null): Promise<Run> {
    const id = this.createRun(goal, scenarioId);
    await this.loop(id);
    return this.store.get(id)!;
  }

  private createRun(goal: string, scenarioId: string | null): string {
    const run = this.store.create(goal, scenarioId, this.model.name);
    const history: Content[] = [{ role: 'user', parts: [{ text: initialUserMessage(goal) }] }];
    this.store.update(run.id, { history });
    this.store.addEvent(run.id, 'run_started', { goal, model: this.model.name, scenario_id: scenarioId });
    return run.id;
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  /**
   * Record a human decision and resume the paused run.
   * Approve → the exact persisted action is executed now. Reject → it is never executed;
   * the model is told it was rejected and decides what to report.
   */
  async decide(approvalId: string, decision: 'approved' | 'rejected', wait = false): Promise<Run> {
    const pendingApproval = this.approvals.get(approvalId);
    if (!pendingApproval) throw new Error(`Unknown approval ${approvalId}`);
    const run = this.store.get(pendingApproval.run_id);
    if (!run || run.status !== 'awaiting_approval' || !run.pending || run.pending.approvalId !== approvalId) {
      throw new Error(`Run is not waiting for approval ${approvalId}`);
    }
    const approval = this.approvals.decide(approvalId, decision);
    this.store.addEvent(run.id, 'approval_decided', { approval_id: approvalId, decision, tool: approval.tool });

    let outcome: ToolOutcome;
    if (decision === 'approved') {
      outcome = this.executor.execute(run.id, { id: approval.call_id ?? undefined, name: approval.tool, args: approval.args }, approval);
    } else {
      outcome = {
        status: 'error',
        error: {
          code: 'REJECTED_BY_HUMAN',
          message: 'A human reviewer rejected this action. It was NOT executed and must not be attempted again in this run.',
          retryable: false,
        },
      };
    }
    const parts = [...run.pending.parts] as Part[];
    parts[run.pending.approvalIndex] = functionResponsePart(
      { id: approval.call_id ?? undefined, name: approval.tool, args: approval.args },
      outcome,
      { human_decision: decision },
    );
    const history = [...run.history, { role: 'user', parts }];
    this.store.update(run.id, { history, pending: null, status: 'running' });

    const loop = this.loop(run.id);
    if (wait) await loop;
    return this.store.get(run.id)!;
  }

  // ---------------------------------------------------------------------------

  private async loop(runId: string): Promise<void> {
    if (this.active.has(runId)) return; // never run two loops for one run
    this.active.add(runId);
    const startedAt = Date.now();
    try {
      for (;;) {
        const run = this.store.get(runId);
        if (!run || run.status !== 'running') return; // deleted by a reset, or paused

        if (run.step_count >= this.maxSteps) {
          return this.finish(runId, 'incomplete', `Stopped: step limit of ${this.maxSteps} model turns reached.`);
        }
        if (Date.now() - startedAt > this.runTimeoutMs) {
          return this.finish(runId, 'incomplete', `Stopped: run exceeded ${Math.round(this.runTimeoutMs / 1000)}s time budget.`);
        }

        // ---- 1. Ask the model what to do next. ----
        const response = await this.model.generate({
          systemInstruction: SYSTEM_INSTRUCTION,
          contents: run.history,
          tools: toolDeclarations(),
          onInfraRetry: (info) => this.store.addEvent(runId, 'model_retry', info),
        });
        if (!this.store.get(runId)) return; // reset while we were waiting on the model

        const history: Content[] = [...run.history];
        const step = run.step_count + 1;
        this.store.addEvent(runId, 'model_turn', {
          step,
          text: response.text,
          tool_calls: response.functionCalls.map((c) => ({ name: c.name, args: redact(c.args) })),
          finish_reason: response.finishReason ?? null,
        });

        // Empty/malformed turn: tell the model and let it try again (bounded by the step limit).
        if (!response.content.parts?.length) {
          history.push({ role: 'user', parts: [{ text: 'Your last response was empty. Continue working on the objective, or give your final report.' }] });
          this.store.update(runId, { history, step_count: step });
          continue;
        }
        history.push(response.content);

        // ---- 2. No tool calls → the model considers itself done. Verify independently. ----
        if (response.functionCalls.length === 0) {
          this.store.update(runId, { history, step_count: step, final_message: response.text });
          this.store.addEvent(runId, 'agent_final', { text: response.text });
          return this.finish(runId, null);
        }

        // ---- 3. Execute each requested call through the guarded executor. ----
        const parts: Part[] = [];
        let paused: { index: number; approvalId: string } | null = null;
        for (const call of response.functionCalls) {
          if (paused) {
            // Calls after one that needs approval are not executed in this turn.
            parts.push(
              functionResponsePart(call, {
                status: 'error',
                error: {
                  code: 'NOT_EXECUTED',
                  message: 'Skipped because an earlier action in the same turn is waiting for human approval. Call it again if still needed.',
                  retryable: true,
                },
              }),
            );
            continue;
          }
          const outcome = this.executor.execute(runId, call);
          if (outcome.status === 'approval_required') {
            paused = { index: parts.length, approvalId: outcome.approval.id };
            parts.push({ text: '[awaiting approval]' }); // placeholder replaced in decide()
          } else {
            parts.push(functionResponsePart(call, outcome));
          }
        }

        // ---- 4a. Pause for a human: persist everything needed to resume later. ----
        if (paused) {
          this.store.update(runId, {
            history,
            step_count: step,
            status: 'awaiting_approval',
            pending: { parts, approvalIndex: paused.index, approvalId: paused.approvalId },
          });
          this.store.addEvent(runId, 'run_status', { status: 'awaiting_approval' });
          return;
        }

        // ---- 4b. Feed the observations back and loop. ----
        history.push({ role: 'user', parts });
        this.store.update(runId, { history, step_count: step });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.store.get(runId)) {
        this.store.addEvent(runId, 'error', { message: message.slice(0, 1000) });
        this.finish(runId, 'failed', `Run failed: ${message.slice(0, 500)}`);
      }
    } finally {
      this.active.delete(runId);
    }
  }

  /**
   * Final status comes from the verifier, never from the model's own claim.
   * forced = a status imposed by the runtime (step limit, timeout, error).
   */
  private finish(runId: string, forced: RunStatus | null, error?: string) {
    const run = this.store.get(runId)!;
    const report = verifyRun(this.db, run);
    let status: RunStatus;
    if (forced) status = forced;
    else if (!report.verifiable) status = 'completed_unverified';
    else status = report.passed ? 'completed_verified' : 'incomplete';

    this.store.update(runId, { status, verification: report, ...(error ? { error } : {}) });
    this.store.addEvent(runId, 'verification', report as unknown as Record<string, unknown>);
    this.store.addEvent(runId, 'run_status', { status, ...(error ? { error } : {}) });
  }
}

/** Build the Gemini functionResponse part that carries a tool observation back to the model. */
function functionResponsePart(call: ModelFunctionCall, outcome: ToolOutcome, extra: Record<string, unknown> = {}): Part {
  const response =
    outcome.status === 'ok'
      ? { output: outcome.data, ...(outcome.replayed ? { note: 'Identical action already succeeded earlier in this run; returning the stored result.' } : {}), ...extra }
      : outcome.status === 'error'
        ? { error: outcome.error, ...extra }
        : { error: { code: 'APPROVAL_REQUIRED', message: outcome.approval.reason }, ...extra };
  return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } };
}

