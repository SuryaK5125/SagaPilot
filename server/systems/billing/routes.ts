import { Router } from 'express';
import type { DB } from '../../db/database.js';
import * as billing from './service.js';

/** Read-only REST API of the simulated billing system (used by the dashboard). */
export function billingRoutes(db: DB): Router {
  const r = Router();
  r.get('/plans', (_req, res) => res.json(billing.listPlans(db)));
  r.get('/customers', (req, res) => res.json(billing.listCustomers(db, req.query.search as string | undefined)));
  r.get('/customers/:id', (req, res) => res.json(billing.getCustomer(db, req.params.id)));
  r.get('/customers/:id/subscription', (req, res) => res.json(billing.getSubscription(db, req.params.id)));
  r.get('/subscription-changes', (_req, res) =>
    res.json(db.prepare('SELECT * FROM subscription_changes ORDER BY id DESC').all()),
  );
  return r;
}
