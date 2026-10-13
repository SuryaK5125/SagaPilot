/**
 * Minimal Gemini connectivity + function-calling check.
 * Run: npm run gemini:smoke
 * 1. Lists models that support generateContent (to confirm GEMINI_MODEL exists).
 * 2. Sends one prompt with a single tool and checks that the model returns a real function call.
 * The API key is never printed.
 */
import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

async function main() {
  if (!config.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set. Copy .env.example to .env and add a key.');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  console.log(`Configured model: ${config.geminiModel}`);
  const available: string[] = [];
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  for await (const m of pager) {
    if (m.supportedActions?.includes('generateContent') && m.name) available.push(m.name.replace(/^models\//, ''));
  }
  const flashLike = available.filter((n) => /gemini-(2\.5|3)/.test(n));
  console.log(`Models supporting generateContent (gemini 2.5/3 family): ${flashLike.join(', ') || '(none listed)'}`);
  if (!available.includes(config.geminiModel)) {
    console.warn(`WARNING: '${config.geminiModel}' is not in the model list for this key.`);
  }

  const res = await ai.models.generateContent({
    model: config.geminiModel,
    contents: [{ role: 'user', parts: [{ text: 'What plan is customer cus_acme on? Use the tool.' }] }],
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_subscription',
              description: "Get a customer's current subscription.",
              parametersJsonSchema: {
                type: 'object',
                properties: { customer_id: { type: 'string', description: 'Customer id' } },
                required: ['customer_id'],
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    },
  });

  const calls = res.functionCalls ?? [];
  console.log('Function calls returned by the model:', JSON.stringify(calls));
  if (calls[0]?.name === 'get_subscription' && calls[0]?.args?.customer_id === 'cus_acme') {
    console.log('SMOKE TEST PASSED: Gemini connectivity and function calling work.');
  } else {
    console.error('SMOKE TEST FAILED: expected a get_subscription call with customer_id=cus_acme. Text:', res.text);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('SMOKE TEST ERROR:', e?.status ?? '', e?.message ?? e);
  process.exit(3);
});
