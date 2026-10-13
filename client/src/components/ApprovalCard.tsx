import type { Approval } from '../api';

export function ApprovalCard({ approval, busy, onDecide }: { approval: Approval; busy: boolean; onDecide: (d: 'approve' | 'reject') => void }) {
  return (
    <div className="approval">
      <div className="approval-title">Human approval required</div>
      <p>{approval.reason}</p>
      <pre>{approval.tool}({JSON.stringify(approval.args, null, 2)})</pre>
      <div className="row">
        <button onClick={() => onDecide('approve')} disabled={busy}>Approve</button>
        <button className="danger" onClick={() => onDecide('reject')} disabled={busy}>Reject</button>
      </div>
    </div>
  );
}
