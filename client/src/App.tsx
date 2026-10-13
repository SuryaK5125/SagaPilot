import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Health, type RunDetail, type Scenario, type SystemState } from './api';
import { Trace } from './components/Trace';
import { SystemsPanel } from './components/SystemsPanel';
import { VerificationPanel } from './components/VerificationPanel';
import { ApprovalCard } from './components/ApprovalCard';
import { StatusBadge } from './components/StatusBadge';

const LIVE = ['running', 'awaiting_approval'];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [goal, setGoal] = useState('');
  const [scenarioId, setScenarioId] = useState<string | undefined>();
  const [failureKind, setFailureKind] = useState('transient_503');
  const [state, setState] = useState<SystemState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;

  const refreshState = useCallback(() => api.state().then(setState).catch((e) => setError(e.message)), []);
  const refreshRun = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    try {
      setRun(await api.run(id));
    } catch {
      setRun(null); // run was wiped by a reset
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(e.message));
    api.scenarios().then(setScenarios).catch(() => {});
    refreshState();
    // After a page reload, reattach to the most recent run.
    api
      .runs()
      .then((runs) => {
        if (runs[0] && !runIdRef.current) {
          setRunId(runs[0].id);
          runIdRef.current = runs[0].id;
          refreshRun();
        }
      })
      .catch(() => {});
  }, [refreshState, refreshRun]);

  // Simple polling: fast while a run is live, slow otherwise.
  const live = !!run && (LIVE.includes(run.status) || run.active);
  useEffect(() => {
    const t = setInterval(() => {
      refreshState();
      refreshRun();
    }, live ? 1000 : 4000);
    return () => clearInterval(t);
  }, [live, refreshState, refreshRun]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await Promise.all([refreshState(), refreshRun()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadScenario = (s: Scenario) => {
    setGoal(s.goal);
    setScenarioId(s.id);
  };

  const start = () =>
    act(async () => {
      const { id } = await api.startRun(goal, scenarioId);
      setRunId(id);
      runIdRef.current = id;
    });

  const reset = () =>
    act(async () => {
      await api.reset();
      setRunId(null);
      setRun(null);
    });

  const pending = run?.approvals.find((a) => a.status === 'pending');
  const running = !!run && LIVE.includes(run.status);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>SagaPilot</h1>
          <p className="tagline">Autonomous operator for Billing, Access and Tasks. Gemini picks every action; the systems enforce the rules; a separate verifier checks the result.</p>
        </div>
        <div className="model-pill" title={health?.agent_error ?? ''}>
          <span className={`dot ${health?.agent_ready ? 'ok' : 'bad'}`} />
          {health ? (health.agent_ready ? health.model : `Agent unavailable: ${health.agent_error}`) : '…'}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <main className="grid">
        <section className="card objective">
          <h2>Objective</h2>
          <div className="row wrap">
            {scenarios.map((s) => (
              <button key={s.id} className="secondary" onClick={() => loadScenario(s)} disabled={busy}>
                {s.title}
              </button>
            ))}
          </div>
          <textarea
            value={goal}
            placeholder="Describe a business objective in plain English…"
            onChange={(e) => {
              setGoal(e.target.value);
              setScenarioId(scenarios.find((s) => s.goal === e.target.value)?.id);
            }}
            rows={3}
          />
          <div className="row">
            <button onClick={start} disabled={busy || running || goal.trim().length < 5 || !health?.agent_ready}>
              {running ? 'Agent running…' : 'Run agent'}
            </button>
            <button className="secondary" onClick={reset} disabled={busy}>Reset demo data</button>
            <span className="hint">{scenarioId ? `Verifiable scenario: ${scenarioId}` : goal ? 'Custom goal (cannot be fully verified)' : ''}</span>
          </div>

          <div className="failure">
            <h3>Failure injection <span className="hint">(simulated environment, access provisioning)</span></h3>
            <div className="row">
              <select value={failureKind} onChange={(e) => setFailureKind(e.target.value)}>
                <option value="transient_503">One-time 503 on set_entitlements</option>
                <option value="workspace_suspended">Workspace gets suspended before provisioning</option>
              </select>
              <button className="secondary" onClick={() => act(() => api.injectFailure(failureKind))} disabled={busy}>Arm</button>
              <button className="ghost" onClick={() => act(() => api.clearFailures())} disabled={busy || !state?.failures.length}>Clear</button>
            </div>
            <div className="armed">
              {state?.failures.length
                ? state.failures.map((f) => <span key={f.id} className="chip warn">armed: {f.kind} ×{f.remaining}</span>)
                : <span className="hint">No failure armed.</span>}
            </div>
          </div>
        </section>

        <section className="card run">
          <div className="run-head">
            <h2>Execution trace</h2>
            {run && <StatusBadge status={run.status} />}
          </div>
          {run && <div className="run-meta">{run.id} · {run.model} · {run.step_count} model turns</div>}
          {pending && <ApprovalCard approval={pending} busy={busy} onDecide={(d) => act(() => api.decide(pending.id, d))} />}
          {run ? <Trace events={run.events} /> : <p className="empty">No run yet. Load a scenario and press “Run agent”.</p>}
        </section>

        <section className="card verify">
          <h2>Independent verification</h2>
          {run?.verification ? <VerificationPanel report={run.verification} /> : <p className="empty">Runs are verified against the database when the agent stops.</p>}
          {run?.error && <p className="run-error">{run.error}</p>}
        </section>
      </main>

      {state && <SystemsPanel state={state} />}
    </div>
  );
}
