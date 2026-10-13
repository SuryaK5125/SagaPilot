import { useEffect, useRef, type ReactNode } from 'react';
import type { RunEvent } from '../api';

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Renders the persisted run events exactly as the backend recorded them. */
export function Trace({ events }: { events: RunEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  // Keep the newest event in view by scrolling only the trace panel (not the page).
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length]);

  return (
    <div className="trace" ref={box}>
      {events.map((e) => (
        <TraceItem key={e.id} e={e} />
      ))}
    </div>
  );
}

function TraceItem({ e }: { e: RunEvent }) {
  const p = e.payload;
  const time = new Date(e.created_at).toLocaleTimeString();
  switch (e.type) {
    case 'run_started':
      return <Item kind="info" time={time} title="Run started">{p.goal}</Item>;
    case 'model_turn':
      return (
        <Item kind="model" time={time} title={`Step ${p.step} · Gemini decided`}>
          {p.text && p.tool_calls?.length > 0 && <div className="model-text">{p.text}</div>}
          {p.tool_calls?.length ? (
            <div className="hint">calls: {p.tool_calls.map((c: any) => c.name).join(', ')}</div>
          ) : (
            <div className="hint">no tool calls → final report</div>
          )}
        </Item>
      );
    case 'tool_call':
      return (
        <Item kind="call" time={time} title={`→ ${p.tool}${p.approval_id ? ' (approved by human)' : ''}`}>
          <details><summary>arguments</summary><pre>{json(p.args)}</pre></details>
        </Item>
      );
    case 'tool_result':
      return p.ok ? (
        <Item kind="ok" time={time} title={`✓ ${p.tool}${p.replayed ? ' (idempotent replay)' : ''}`}>
          <details><summary>observation</summary><pre>{json(p.data)}</pre></details>
        </Item>
      ) : (
        <Item kind="err" time={time} title={`✗ ${p.tool} — ${p.error?.code}`}>
          <div>{p.error?.message}</div>
        </Item>
      );
    case 'approval_requested':
      return <Item kind="warn" time={time} title={`⏸ Approval requested for ${p.tool}`}>{p.reason}</Item>;
    case 'approval_decided':
      return <Item kind={p.decision === 'approved' ? 'ok' : 'err'} time={time} title={`Human ${p.decision} ${p.tool}`} />;
    case 'model_retry':
      return <Item kind="info" time={time} title={`Gemini API retry #${p.attempt} (status ${p.status ?? '?'}) in ${Math.round(p.delayMs / 1000)}s`} />;
    case 'agent_final':
      return <Item kind="model" time={time} title="Agent final report"><div className="model-text">{p.text}</div></Item>;
    case 'verification':
      return <Item kind={p.passed ? 'ok' : p.verifiable ? 'err' : 'warn'} time={time} title="Verifier">{p.summary}</Item>;
    case 'run_status':
      return <Item kind="info" time={time} title={`Status → ${p.status}`}>{p.error}</Item>;
    case 'error':
      return <Item kind="err" time={time} title="Runtime error">{p.message}</Item>;
    default:
      return <Item kind="info" time={time} title={e.type}><pre>{json(p)}</pre></Item>;
  }
}

function Item({ kind, time, title, children }: { kind: string; time: string; title: string; children?: ReactNode }) {
  return (
    <div className={`ev ev-${kind}`}>
      <div className="ev-head"><span className="ev-title">{title}</span><span className="ev-time">{time}</span></div>
      {children && <div className="ev-body">{children}</div>}
    </div>
  );
}
