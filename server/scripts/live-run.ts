/**
 * Run a real Gemini-powered scenario from the command line against a fresh,
 * separate database, printing the full trace and the verifier report.
 *
 *   npm run live:run -- upgrade                       # Scenario A
 *   npm run live:run -- upgrade --fail transient_503   # with an injected failure
 *   npm run live:run -- downgrade --approve            # Scenario B, auto-approve as "the human"
 *   npm run live:run -- downgrade --reject
 *
 * --approve / --reject play the role of the human reviewer so the run can be
 * captured non-interactively. The agent's decisions still come from Gemini.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { resetDatabase } from '../db/seed.js';
import { AgentRunner } from '../agent/runner.js';
import { GeminiAdapter } from '../agent/gemini.js';
import { injectFailure, type FailureKind } from '../systems/failures.js';
import { SCENARIOS } from '../scenarios/scenarios.js';

const args = process.argv.slice(2);
const scenarioId = args[0] ?? 'upgrade';
const failIdx = args.indexOf('--fail');
const failures = failIdx >= 0 ? (args[failIdx + 1] ?? '').split(',').filter(Boolean) as FailureKind[] : [];
const decision = args.includes('--reject') ? 'rejected' : 'approved';

async function main() {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario '${scenarioId}'`);

  const dbFile = path.resolve('data', `live-${scenarioId}.db`);
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  const db = openDatabase(dbFile);
  resetDatabase(db);
  for (const kind of failures) injectFailure(db, 'access.set_entitlements', kind);

  const runner = new AgentRunner(db, new GeminiAdapter({ apiKey: config.geminiApiKey, model: config.geminiModel }));
  console.log(`\n=== ${scenario.title} | model=${config.geminiModel} | injected=${failures.join(',') || 'none'} ===\n`);
  let run = await runner.startAndWait(scenario.goal, scenario.id);
  let printed = 0;
  const print = () => {
    for (const e of runner.store.events(run.id, printed)) {
      printed = e.id;
      console.log(`[${e.type}] ${JSON.stringify(e.payload)}`);
    }
  };
  print();
  while (run.status === 'awaiting_approval') {
    const approval = runner.approvals.pendingForRun(run.id)!;
    console.log(`\n>>> Human reviewer (CLI flag) decides: ${decision.toUpperCase()} ${approval.id}: ${approval.reason}\n`);
    run = await runner.decide(approval.id, decision, true);
    print();
  }
  console.log(`\n=== FINAL STATUS: ${run.status} | model turns: ${run.step_count} ===`);
}

main().catch((e) => {
  console.error('LIVE RUN ERROR:', e?.message ?? e);
  process.exit(1);
});
