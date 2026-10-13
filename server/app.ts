import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from './db/database.js';
import { resetDatabase } from './db/seed.js';
import { billingRoutes } from './systems/billing/routes.js';
import { accessRoutes } from './systems/access/routes.js';
import { taskRoutes } from './systems/tasks/routes.js';
import { ServiceError } from './systems/errors.js';
import { clearFailures, FAILURE_KINDS, FAILURE_OPERATIONS, injectFailure, listActiveFailures } from './systems/failures.js';
import { listCustomers, listPlans } from './systems/billing/service.js';
import { listWorkspaces } from './systems/access/service.js';
import { listTasks } from './systems/tasks/service.js';
import { SCENARIOS } from './scenarios/scenarios.js';
import type { AgentRunner } from './agent/runner.js';

export interface AppDeps {
  db: DB;
  /** null when GEMINI_API_KEY is missing: the dashboard still works, runs are refused with a clear error. */
  runner: AgentRunner | null;
  modelName: string;
  runnerError?: string;
}

export function createApp({ db, runner, modelName, runnerError }: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true, model: modelName, agent_ready: !!runner, agent_error: runnerError ?? null }));

  // ---- Simulated company systems (read APIs) ----
  app.use('/api/billing', billingRoutes(db));
  app.use('/api/access', accessRoutes(db));
  app.use('/api/tasks', taskRoutes(db));

  /** One snapshot of all three systems for the dashboard. */
  app.get('/api/state', (_req, res) => {
    res.json({
      plans: listPlans(db),
      customers: listCustomers(db),
      workspaces: listWorkspaces(db),
      tasks: listTasks(db),
      failures: listActiveFailures(db),
    });
  });

  // ---- Demo controls ----
  app.get('/api/scenarios', (_req, res) => res.json(SCENARIOS.map(({ id, title, goal }) => ({ id, title, goal }))));

  app.post('/api/reset', (_req, res) => {
    // Runs that are mid-flight notice their row disappeared and stop.
    resetDatabase(db);
    res.json({ ok: true });
  });

  app.get('/api/failures', (_req, res) => res.json({ active: listActiveFailures(db), kinds: FAILURE_KINDS }));
  app.post('/api/failures', (req, res) => {
    const body = z
      .object({
        operation: z.enum(FAILURE_OPERATIONS).default('access.set_entitlements'),
        kind: z.enum(Object.keys(FAILURE_KINDS) as [keyof typeof FAILURE_KINDS]),
        times: z.number().int().min(1).max(5).default(1),
      })
      .parse(req.body);
    injectFailure(db, body.operation, body.kind, body.times);
    res.json({ active: listActiveFailures(db) });
  });
  app.delete('/api/failures', (_req, res) => {
    clearFailures(db);
    res.json({ active: [] });
  });

  // ---- Agent runs ----
  const requireRunner = (): AgentRunner => {
    if (!runner) throw new ServiceError('AGENT_UNAVAILABLE', runnerError ?? 'Agent is not configured', 503);
    return runner;
  };

  app.post('/api/runs', (req, res) => {
    const body = z.object({ goal: z.string().min(5).max(1000), scenario_id: z.string().optional() }).parse(req.body);
    const run = requireRunner().start(body.goal, body.scenario_id ?? null);
    res.status(202).json({ id: run.id, status: run.status });
  });

  app.get('/api/runs', (_req, res) => res.json(runner ? runner.store.list() : []));

  app.get('/api/runs/:id', (req, res) => {
    const r = requireRunner();
    const run = r.store.get(req.params.id);
    if (!run) throw new ServiceError('RUN_NOT_FOUND', 'Run not found', 404);
    const { history: _history, pending: _pending, ...publicRun } = run; // raw model history stays server-side
    res.json({
      ...publicRun,
      active: r.isActive(run.id),
      approvals: r.approvals.listForRun(run.id),
      events: r.store.events(run.id, Number(req.query.after ?? 0)),
    });
  });

  app.post('/api/approvals/:id/:decision', async (req, res, next) => {
    try {
      const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
      const run = await requireRunner().decide(req.params.id, decision === 'approve' ? 'approved' : 'rejected');
      res.json({ run_id: run.id, status: run.status });
    } catch (e) {
      next(e);
    }
  });

  // ---- Built dashboard (production mode) ----
  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (e instanceof ServiceError) return res.status(e.httpStatus).json({ error: e.toJSON() });
    if (e instanceof z.ZodError) return res.status(400).json({ error: { code: 'INVALID_REQUEST', issues: e.issues } });
    const message = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
  });

  return app;
}
