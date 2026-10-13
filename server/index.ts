import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { seedIfEmpty } from './db/seed.js';
import { createApp } from './app.js';
import { AgentRunner } from './agent/runner.js';
import { GeminiAdapter } from './agent/gemini.js';

const db = openDatabase(config.dbPath);
seedIfEmpty(db);

let runner: AgentRunner | null = null;
let runnerError: string | undefined;
try {
  runner = new AgentRunner(db, new GeminiAdapter({ apiKey: config.geminiApiKey, model: config.geminiModel }));
} catch (e) {
  // No silent fallback to a fake model: the dashboard shows this error and runs are refused.
  runnerError = e instanceof Error ? e.message : String(e);
  console.warn(`[sagapilot] Agent disabled: ${runnerError}`);
}

// Runs that were mid-loop when the server stopped cannot continue (their in-memory loop is gone).
db.prepare(`UPDATE runs SET status = 'failed', error = 'Server restarted while the run was in progress' WHERE status = 'running'`).run();

createApp({ db, runner, modelName: config.geminiModel, runnerError }).listen(config.port, () => {
  console.log(`[sagapilot] API listening on http://localhost:${config.port} (model: ${config.geminiModel})`);
});
