import type { SystemState } from '../api';

/** Live view of the three simulated systems, read straight from the database. */
export function SystemsPanel({ state }: { state: SystemState }) {
  const planName = (id: string) => state.plans.find((p) => p.id === id)?.name ?? id;
  const customerName = (id: string) => state.customers.find((c) => c.id === id)?.name ?? id;

  return (
    <section className="systems">
      <div className="card">
        <h2>Billing</h2>
        <table>
          <thead><tr><th>Customer</th><th>Plan</th><th>Status</th></tr></thead>
          <tbody>
            {state.customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}<div className="sub">{c.id}</div></td>
                <td><span className={`plan p-${c.plan_id}`}>{planName(c.plan_id)}</span></td>
                <td>{c.subscription_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Access management</h2>
        <table>
          <thead><tr><th>Workspace</th><th>Status</th><th>Entitlements</th></tr></thead>
          <tbody>
            {state.workspaces.map((w) => (
              <tr key={w.id}>
                <td>{w.name}<div className="sub">{w.id}</div></td>
                <td><span className={`chip ${w.status === 'active' ? 'ok' : 'warn'}`}>{w.status}</span></td>
                <td>
                  {w.enabled_entitlements.map((f) => (
                    <span key={f} className={`chip ${w.enabled_but_not_in_plan.includes(f) ? 'bad' : ''}`} title={w.enabled_but_not_in_plan.includes(f) ? 'Not allowed by current plan' : ''}>{f}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Task management</h2>
        <table>
          <thead><tr><th>Task</th><th>Type / team</th><th>Status</th></tr></thead>
          <tbody>
            {[...state.tasks].reverse().map((t) => (
              <tr key={t.id} className={t.run_id ? 'agent-row' : ''}>
                <td>{t.title}<div className="sub">{customerName(t.customer_id)} · {t.id}{t.run_id ? ` · by ${t.run_id}` : ''}</div></td>
                <td>{t.type}<div className="sub">{t.team}</div></td>
                <td>{t.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
