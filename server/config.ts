import path from 'node:path';

// Load .env without an extra dependency (Node >= 20.12 has process.loadEnvFile).
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  port: Number(process.env.PORT || 3001),
  dbPath: process.env.SAGAPILOT_DB || path.resolve(process.cwd(), 'data', 'sagapilot.db'),
};
