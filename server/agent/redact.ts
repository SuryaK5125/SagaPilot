const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authorization|email)/i;

/** Deep-copy a value, masking fields whose names look sensitive. Used before anything goes into the trace. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

/** Stable JSON (sorted keys) so the same arguments always produce the same signature. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Signature of what an action *does*: tool name + arguments, ignoring the
 * free-text `reason`. Rewording the justification must not let the agent
 * bypass a rejection, a retry limit or an idempotency key.
 */
export function actionSignature(tool: string, args: Record<string, unknown>): string {
  const { reason: _ignored, ...effect } = args;
  return `${tool}:${canonicalJson(effect)}`;
}
