# SagaPilot

**An autonomous AI operator for multi-system business workflows.**

SagaPilot is a prototype I built for the CentrAlign AI engineering assignment. It takes a business task in plain English and attempts to complete it across three simulated company systems: Billing, Access Management, and Task Management.

The main problem I wanted to explore was what happens when an AI agent completes part of a task, but another operation fails. How should it recover, and how can we verify that the task was actually completed?

## What it does

For example, a user can ask:

> Upgrade Acme Corp to Enterprise, enable the appropriate premium access, and create an onboarding task.

SagaPilot uses Gemini to decide which tools to call and in what order. The tools update real records in a local SQLite database.

I focused on four things:

- **Autonomous execution:** Gemini selects tools based on the goal and previous results, rather than following a fixed workflow.
- **Failure recovery:** The agent receives tool errors and decides whether to investigate, retry, or stop.
- **Human approval:** Sensitive actions, such as subscription downgrades, require approval before execution.
- **Independent verification:** A separate verifier checks the database instead of trusting the LLM's final response.

## How it works

The system has three main parts:

1. **Agent runner:** Sends the goal and available tools to Gemini, receives function calls, and passes tool results back to the model.
2. **Tool executor:** Validates arguments, enforces business rules and approvals, and executes operations against the simulated systems.
3. **Verifier:** Queries SQLite to check whether the requested outcome was achieved.

The basic flow is:

`Goal → Gemini → Tool Executor → Business Systems → Verification`

Tool results and errors return to Gemini, allowing it to decide the next action.

The business systems and safety rules are deterministic. Gemini controls tool selection and recovery decisions, but cannot directly bypass the executor.

## Tech stack

- **Backend:** TypeScript, Node.js, Express
- **Frontend:** React, Vite
- **Database:** SQLite (better-sqlite3)
- **LLM:** Google Gemini API with function calling
- **Validation:** Zod
- **Testing:** Vitest

I implemented a custom agent loop rather than using an agent orchestration framework.

## Running locally

Requires Node.js 20.12 or newer and a Gemini API key.

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/SuryaK5125/SagaPilot.git
cd SagaPilot
npm install
```

2. Copy `.env.example` to `.env` and add your Gemini API key.

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-3.1-flash-lite
PORT=3001
```

3. Start the application:

```bash
npm run dev
```

Open `http://localhost:5173`.

The application creates and seeds its local database automatically.

## Demo scenarios

### 1. Customer upgrade with failure recovery

Ask the agent to upgrade Acme Corp to Enterprise.

The dashboard lets you inject a temporary 503 error into access provisioning. In a successful test, Gemini received the error, retried the operation, and completed the remaining task.

A second failure scenario suspends the workspace. In a recorded test, Gemini independently chose to reactivate the workspace before retrying provisioning.

### 2. Customer downgrade with human approval

Ask the agent to downgrade Beacon Labs to Starter.

The subscription change pauses until a human approves or rejects it. If approved, the agent continues updating access and creating the transition task. If rejected, the restricted action is not executed.

Both scenarios have predefined verification checks against the final database state.

## Testing

The project has **32 unit tests** covering tool execution, validation, approval handling, idempotency, failure injection, and verification.

```bash
npm test
npm run typecheck
npm run build
```

I also tested the agent with real Gemini function calls.

The successful upgrade and approved downgrade runs passed all **5/5 independent verification checks**. A rejected downgrade was correctly reported as incomplete.

Recorded execution logs are available in [`docs/live-runs/`](docs/live-runs/).

## Project structure

| Location | Purpose |
|---|---|
| `client/` | React dashboard |
| `server/agent/` | Gemini integration, agent loop, tools, and approvals |
| `server/systems/` | Simulated Billing, Access, and Task systems |
| `server/verification/` | Independent database checks |
| `server/scenarios/` | Demo goals and acceptance conditions |
| `tests/` | Unit tests |
| `docs/live-runs/` | Recorded Gemini executions |

## Limitations and next steps

This is a proof of concept, not a production-ready enterprise operator.

The main limitation is verification: the agent can attempt other goals using its available tools, but only the two demo scenarios have predefined acceptance conditions.

The systems are simulated, approvals have no user authentication, and active runs cannot resume after a server restart. Full compensating rollback for partially completed workflows is also not implemented.

With more time, I'd focus on generalizing verification, adding durable execution, improving authorization, and evaluating recovery across more failure scenarios.

## AI tools and acknowledgments

I used Claude Code extensively for implementation, testing, and debugging, with ChatGPT and Claude for planning and architecture review.

The runtime uses Google Gemini through the official `@google/genai` SDK. No pre-built agent application template or agent orchestration framework was used.

All company records and demo environments are synthetic.
