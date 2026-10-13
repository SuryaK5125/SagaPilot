import type { Content } from '@google/genai';

/**
 * The runner talks to the LLM only through this interface. Production uses
 * GeminiAdapter; unit tests use a clearly named FakeModelAdapter.
 *
 * Conversation history uses Gemini's `Content` shape directly so that the
 * model's own messages (including any thought signatures) are preserved
 * exactly between steps.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface ModelRequest {
  systemInstruction: string;
  contents: Content[];
  tools: ToolDeclaration[];
  /** Called when the adapter retries an infrastructure error (rate limit, 5xx). */
  onInfraRetry?: (info: { attempt: number; status?: number; delayMs: number; message: string }) => void;
}

export interface ModelFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelResponse {
  /** The model turn exactly as returned, appended to history unchanged. */
  content: Content;
  functionCalls: ModelFunctionCall[];
  text: string;
  finishReason?: string;
}

export interface ModelAdapter {
  readonly name: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}
