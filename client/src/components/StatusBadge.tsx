const LABELS: Record<string, string> = {
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  completed_verified: 'Completed & verified',
  completed_unverified: 'Completed (not verifiable)',
  incomplete: 'Incomplete',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge s-${status}`}>{LABELS[status] ?? status}</span>;
}
