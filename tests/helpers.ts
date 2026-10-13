import type { Content } from '@google/genai';
import { openDatabase } from '../server/db/database.js';
import { resetDatabase } from '../server/db/seed.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ModelFunctionCall } from '../server/agent/model.js';

export function freshDb() {
  const db = openDatabase(':memory:');
  resetDatabase(db);
  return db;
}

/**
 * FAKE MODEL ADAPTER — FOR DETERMINISTIC UNIT TESTS ONLY.
 *
 * It does not call any LLM. Each test supplies a `decide` function that looks
 * at the conversation (including real tool observations) and returns the next
 * tool calls or a final text. This lets us test the runtime loop (execution,
 * approvals, retries, verification) without network access. It proves nothing
 * about the real model's autonomy; that is what the live Gemini runs are for.
 */
export class FakeModelAdapter implements ModelAdapter {
  readonly name = 'fake-model-for-tests';
  requests: ModelRequest[] = [];

  constructor(private decide: (ctx: { step: number; lastResults: Record<string, unknown>[]; contents: Content[] }) => ModelFunctionCall[] | string) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const last = req.contents[req.contents.length - 1];
    const lastResults = (last?.parts ?? [])
      .filter((p) => p.functionResponse)
      .map((p) => ({ name: p.functionResponse!.name, ...(p.functionResponse!.response as Record<string, unknown>) }));
    const out = this.decide({ step: this.requests.length, lastResults, contents: req.contents });
    if (typeof out === 'string') {
      return { content: { role: 'model', parts: [{ text: out }] }, functionCalls: [], text: out };
    }
    return {
      content: { role: 'model', parts: out.map((c) => ({ functionCall: { name: c.name, args: c.args } })) },
      functionCalls: out,
      text: '',
    };
  }
}
