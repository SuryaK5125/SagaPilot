import { FunctionCallingConfigMode, GoogleGenAI, type Content } from '@google/genai';
import type { ModelAdapter, ModelRequest, ModelResponse } from './model.js';

export interface GeminiAdapterOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Thin wrapper over the official @google/genai SDK.
 * Retries here are *infrastructure* retries (rate limits, Gemini outages),
 * not business decisions; those stay with the model.
 */
export class GeminiAdapter implements ModelAdapter {
  readonly name: string;
  private ai: GoogleGenAI;

  constructor(private opts: GeminiAdapterOptions) {
    if (!opts.apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.name = opts.model;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const maxRetries = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.ai.models.generateContent({
          model: this.opts.model,
          contents: req.contents,
          config: {
            systemInstruction: req.systemInstruction,
            tools: [{ functionDeclarations: req.tools }],
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            httpOptions: { timeout: this.opts.timeoutMs ?? 90_000 },
          },
        });
        const candidate = res.candidates?.[0];
        const content: Content = candidate?.content?.parts?.length ? candidate.content : { role: 'model', parts: [] };
        if (!content.role) content.role = 'model';
        return {
          content,
          functionCalls: (res.functionCalls ?? []).map((fc) => ({
            id: fc.id,
            name: fc.name ?? '',
            args: (fc.args ?? {}) as Record<string, unknown>,
          })),
          text: (content.parts ?? [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('')
            .trim(),
          finishReason: candidate?.finishReason,
        };
      } catch (e: any) {
        const status: number | undefined = e?.status ?? e?.code;
        const retryable = status === 429 || (status !== undefined && status >= 500) || /timed? ?out|ECONNRESET|fetch failed/i.test(String(e?.message));
        if (!retryable || attempt >= maxRetries) throw e;
        const raw = String(e?.message ?? e);
        const metric = /Quota exceeded for metric: ([^\s,]+)/.exec(raw)?.[1];
        // Gemini 429s say e.g. "Please retry in 12.3s" or "retry in 5h42m18s"; honour that, otherwise exponential backoff.
        const suggestedMs = parseRetryDelayMs(raw);
        if (suggestedMs !== null && suggestedMs > 90_000) {
          // A daily quota: waiting inside the run is pointless. Fail clearly instead.
          throw new Error(`Gemini quota exhausted${metric ? ` (${metric})` : ''}; API asks to retry in ${Math.round(suggestedMs / 60_000)} min.`);
        }
        const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
        const delayMs = (suggestedMs !== null ? suggestedMs + 500 : backoff) + Math.floor(Math.random() * 500);
        const message = metric ? `Quota exceeded: ${metric}` : raw.slice(0, 300);
        req.onInfraRetry?.({ attempt: attempt + 1, status, delayMs, message });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}

/** Parse "retry in 1h2m3.5s" / "retry in 36s" from a Gemini error message. */
export function parseRetryDelayMs(message: string): number | null {
  const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.ceil(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000);
}
