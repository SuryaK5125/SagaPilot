import { Router } from 'express';
import type { DB } from '../../db/database.js';
import * as access from './service.js';

/** Read-only REST API of the simulated access-management system. */
export function accessRoutes(db: DB): Router {
  const r = Router();
  r.get('/features', (_req, res) => res.json(access.listFeatures(db)));
  r.get('/workspaces', (req, res) => res.json(access.listWorkspaces(db, req.query.customer_id as string | undefined)));
  r.get('/workspaces/:id', (req, res) => res.json(access.getWorkspace(db, req.params.id)));
  return r;
}
