# ⚠️ DRAFT application answers — verify before submitting

> These are **drafts** written alongside the implementation. Before you paste any of them, re-run the tests and at least one live scenario yourself, check every claim against the code and `docs/live-runs/`, and rewrite them in your own voice. Remove anything you can't explain in an interview.

---

### What did you build? (short)

SagaPilot is an autonomous "AI operations employee". Given a goal like *"Upgrade Acme Corp to Enterprise, enable the appropriate premium access, and create the required onboarding task"*, it uses Gemini function calling to operate three simulated company systems (billing, access management, task management) backed by SQLite. It recovers from injected failures, pauses for human approval when company rules require it, and finishes only when an independent verifier confirms the database is in the required state.

### What is actually autonomous?

Gemini picks every tool call and its arguments, including how to react to failures. There is no scenario-specific workflow in the code: both demo scenarios use the same runner, tools and system prompt. In a recorded live run, provisioning failed with `WORKSPACE_INACTIVE`. The model called `reactivate_workspace` on its own (the prompt never mentions that tool), retried provisioning, and the verifier passed all 5 checks. In another run it retried after a one-time 503.

### What is deterministic, and why?

Safety and truth are kept out of the model's hands on purpose. Argument validation (Zod), the closed tool list, domain rules (no features outside the plan, active workspace required), downgrade approval, idempotency keys, retry caps, step and time limits, and the final status (decided by a verifier that runs its own SQL) are all plain code. The model can read the rules but cannot bypass them. A rejected action stays blocked even if the model rewords it.

### Hardest engineering problem?

Making partial failure across systems safe and observable. In practice that meant: (1) errors are returned to the model as structured observations (`code`, `http_status`, `retryable`) rather than exceptions; (2) only successful mutations are stored under idempotency keys, so transient failures can be retried without double-applying successes; (3) pausing mid-turn for approval requires persisting both the Gemini conversation (including thought signatures) and the partially built function responses, so the run resumes exactly where it stopped.

### How did you test it?

32 Vitest unit tests: seeding and reset, read and mutation tools, invalid arguments, idempotency, approval enforcement, verifier false-success detection, failure injection, and the agent loop driven by a clearly labelled `FakeModelAdapter`. Separately, live Gemini runs (logs in `docs/live-runs/`): upgrade with a 503 → verified; upgrade with a suspended workspace → verified (flash-lite); downgrade approved → verified; downgrade rejected → incomplete with nothing changed; plus both scenarios through the dashboard. One live run failed honestly when the free-tier daily quota ran out mid-run, and the verifier reported it as 2/5.

### What would you do next?

Per-goal acceptance criteria (model-proposed, human-approved) so arbitrary goals become verifiable; an evaluation harness measuring success rate across repeated live runs; compensating actions for partially completed changes; authenticated approvers; a durable job queue.

### Limitations you'd mention honestly

Only two scenarios are verifiable. Free-tier Gemini quotas limit how many live runs fit in a day. No authentication. Runs are in-process. LLM behaviour varies between runs, so the demo trace isn't identical each time.

### How did you use AI tools?

The codebase was generated and iterated with Claude Code from a detailed specification, including running the tests and live Gemini runs and fixing issues found along the way (e.g. a model that was no longer available, quota handling, a React effect bug). *(Edit this to describe accurately what you personally designed, reviewed, and changed.)*
