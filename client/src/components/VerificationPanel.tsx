import type { CheckResult, Verification } from '../api';

export function VerificationPanel({ report }: { report: Verification }) {
  return (
    <div>
      <p className={`verdict ${report.passed ? 'pass' : report.verifiable ? 'fail' : 'unknown'}`}>{report.summary}</p>
      {report.checks.length > 0 && <Checks items={report.checks} />}
      <details>
        <summary>Company-wide invariants (rule R1)</summary>
        <Checks items={report.invariants} />
      </details>
    </div>
  );
}

function Checks({ items }: { items: CheckResult[] }) {
  return (
    <ul className="checks">
      {items.map((c, i) => (
        <li key={i} className={c.passed ? 'pass' : 'fail'}>
          <span className="mark">{c.passed ? '✓' : '✗'}</span>
          <span className="desc">{c.description}</span>
          {!c.passed && <code className="actual">actual: {JSON.stringify(c.actual)}</code>}
        </li>
      ))}
    </ul>
  );
}
