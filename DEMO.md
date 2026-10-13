# SagaPilot — 60–90 second demo script

**Setup before recording:** run `npm run dev`, open http://localhost:5173 and click **Reset demo data**. Check the pill in the top-right shows the Gemini model name with a green dot.

| Time | Do this | Say this (roughly) |
|---|---|---|
| 0:00–0:08 | Show the whole dashboard. | "SagaPilot is an autonomous operator. It runs three company systems: billing, access and tasks, all backed by one SQLite database." |
| 0:08–0:15 | Click **Scenario A — Upgrade Acme Corp**. In *Failure injection*, pick **One-time 503 on set_entitlements** and click **Arm**. | "I'll give it a business goal, and I'm also making the access-provisioning API fail once with a 503." |
| 0:15–0:40 | Click **Run agent**. Let the trace scroll. Expand one **arguments** and one **observation**. Point at the red **✗ set_entitlements — SERVICE_UNAVAILABLE** entry and the next Gemini step. | "Every step here is a real Gemini function call. It read the rules and the plan catalog, upgraded billing, and then provisioning failed. Nothing in my code says what to do next; Gemini read the 503 and decided to retry." |
| 0:40–0:50 | Point at the **Billing / Access / Tasks** tables (Acme is now Enterprise, has sso/audit_logs/priority_support, and a green onboarding-task row) and the **Independent verification** card. | "The verifier doesn't read the model's summary. It queries the database, and every check passed." |
| 0:50–1:05 | Click **Scenario B — Downgrade Beacon Labs**, then **Run agent**. Wait for the orange **Human approval required** card. | "Downgrades are a hard-coded company rule. The model can't skip approval, so the run is paused and the proposed action is saved." |
| 1:05–1:20 | Click **Approve**. Show the agent continuing: removing premium features and creating the transition task, then the verifier going green. | "After I approve, the exact saved action runs and the agent carries on. It removes the access Starter doesn't allow and creates the transition task. The verifier checks the result again." |
| 1:20–1:30 | (Optional) Mention the **Reject** path or the *workspace suspended* failure. | "If I reject, the action never runs and the run ends as Incomplete. It can't be reported as a success." |

Tips
- A real run takes about 6–8 s per model turn (≈ 1 minute for 8–10 turns), so record the full runs and **cut or speed up** the waiting in editing. Don't fake or reorder events.
- `gemini-3.1-flash-lite` (the default) usually calls tools without writing a narration sentence. `gemini-3-flash-preview` narrates each step, which reads better on camera, but its free tier allows only ~20 requests/day (2–3 runs). If you switch `GEMINI_MODEL` for recording, rehearse with flash-lite first.
- Gemini decides the order of steps itself, so the exact trace (and the number of steps) varies from run to run. Rehearse once and keep the take that reads best.
- If you see `Gemini API retry` entries, the free-tier rate limit was hit; the adapter backs off automatically. Wait or record again.
- To show the precondition-recovery path instead, arm **Workspace gets suspended before provisioning**. The agent should inspect the workspace, call `reactivate_workspace`, then retry.
