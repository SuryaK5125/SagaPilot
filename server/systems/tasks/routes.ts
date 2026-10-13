import { Router } from 'express';
import type { DB } from '../../db/database.js';
import * as tasks from './service.js';

/** Read-only REST API of the simulated task-management system. */
export function taskRoutes(db: DB): Router {
  const r = Router();
  r.get('/', (req, res) => res.json(tasks.listTasks(db, req.query.customer_id as string | undefined)));
  return r;
}
