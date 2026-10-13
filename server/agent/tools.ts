import { z } from 'zod';
import type { DB } from '../db/database.js';
import * as billing from '../systems/billing/service.js';
import * as access from '../systems/access/service.js';
import * as tasks from '../systems/tasks/service.js';
import { COMPANY_RULES } from '../systems/rules.js';

/**
 * Tool registry: the complete, closed list of actions the agent may take.
 * Each tool = name + description (what the LLM reads) + Zod schema (validated
 * by us, never trusted) + a real implementation against the simulated systems.
 *
 * Deliberately NOT exposed: raw SQL, shell, filesystem, arbitrary HTTP.
 */

export interface ToolContext {
  db: DB;
  runId: string;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  system: 'billing' | 'access' | 'tasks' | 'policy';
  /** Mutations get idempotency keys, approval checks and retry limits. */
  kind: 'read' | 'mutation';
  schema: S;
  run: (ctx: ToolContext, args: z.infer<S>) => unknown;
}

const tool = <S extends z.ZodObject>(def: ToolDef<S>) => def as unknown as ToolDef;

const customerId = z.string().min(1).describe("Customer id, e.g. 'cus_xxx' (from list_customers)");
const workspaceId = z.string().min(1).describe("Workspace id, e.g. 'ws_xxx' (from get_customer)");

export const TOOLS: ToolDef[] = [
  tool({
    name: 'get_company_rules',
    description: 'Return the company policies that govern billing, access and task changes. These rules are enforced by the systems.',
    system: 'policy',
    kind: 'read',
    schema: z.object({}).strict(),
    run: () => ({ rules: COMPANY_RULES }),
  }),
  tool({
    name: 'list_customers',
    description: 'List customers with their current plan id and subscription status. Optionally filter by a name/id search string.',
    system: 'billing',
    kind: 'read',
    schema: z.object({ search: z.string().optional().describe('Case-insensitive substring of the customer name or id') }).strict(),
    run: ({ db }, a) => ({ customers: billing.listCustomers(db, a.search) }),
  }),
  tool({
    name: 'get_customer',
    description: 'Get one customer: contact details, current subscription and the ids/status of their workspaces.',
    system: 'billing',
    kind: 'read',
    schema: z.object({ customer_id: customerId }).strict(),
    run: ({ db }, a) => billing.getCustomer(db, a.customer_id),
  }),
  tool({
    name: 'get_plan_catalog',
    description: 'List all subscription plans with rank (higher = more premium), price and the feature entitlements each plan includes.',
    system: 'billing',
    kind: 'read',
    schema: z.object({}).strict(),
    run: ({ db }) => ({ plans: billing.listPlans(db), features: access.listFeatures(db) }),
  }),
  tool({
    name: 'get_subscription',
    description: "Get a customer's current subscription (plan id, plan rank, status).",
    system: 'billing',
    kind: 'read',
    schema: z.object({ customer_id: customerId }).strict(),
    run: ({ db }, a) => billing.getSubscription(db, a.customer_id),
  }),
  tool({
    name: 'change_subscription',
    description:
      "Move a customer's subscription to a different plan. Changing to the plan they already have is a no-op. May require human approval depending on company rules.",
    system: 'billing',
    kind: 'mutation',
    schema: z
      .object({
        customer_id: customerId,
        plan_id: z.string().min(1).describe('Target plan id from get_plan_catalog'),
        reason: z.string().min(3).describe('Short business justification, recorded in the billing history'),
      })
      .strict(),
    run: ({ db, runId }, a) => billing.changeSubscription(db, a.customer_id, a.plan_id, a.reason, runId),
  }),
  tool({
    name: 'get_workspace',
    description:
      'Get a workspace: status (active/suspended and reason), enabled entitlements, entitlements allowed by the customer current plan, and any enabled entitlements not in the plan.',
    system: 'access',
    kind: 'read',
    schema: z.object({ workspace_id: workspaceId }).strict(),
    run: ({ db }, a) => access.getWorkspace(db, a.workspace_id),
  }),
  tool({
    name: 'set_entitlements',
    description:
      'Enable and/or disable feature entitlements on a workspace in one call. Only features in the customer current plan can be enabled. Enabling an already-enabled feature (or disabling a disabled one) is a no-op.',
    system: 'access',
    kind: 'mutation',
    schema: z
      .object({
        workspace_id: workspaceId,
        enable: z.array(z.string()).default([]).describe('Feature keys to enable'),
        disable: z.array(z.string()).default([]).describe('Feature keys to disable'),
      })
      .strict()
      .refine((a) => a.enable.length + a.disable.length > 0, { message: 'Provide at least one feature to enable or disable' }),
    run: ({ db }, a) => access.setEntitlements(db, a.workspace_id, a.enable, a.disable),
  }),
  tool({
    name: 'reactivate_workspace',
    description: 'Reactivate a suspended workspace. Only allowed when the customer subscription status is active.',
    system: 'access',
    kind: 'mutation',
    schema: z.object({ workspace_id: workspaceId, reason: z.string().min(3).describe('Why the workspace is being reactivated') }).strict(),
    run: ({ db }, a) => access.reactivateWorkspace(db, a.workspace_id),
  }),
  tool({
    name: 'get_tasks',
    description: 'List tasks for a customer (any status) in the task-management system.',
    system: 'tasks',
    kind: 'read',
    schema: z.object({ customer_id: customerId }).strict(),
    run: ({ db }, a) => ({ tasks: tasks.listTasks(db, a.customer_id) }),
  }),
  tool({
    name: 'create_task',
    description: 'Create a task for an internal team about a customer. If an identical open task already exists it is returned instead of duplicated.',
    system: 'tasks',
    kind: 'mutation',
    schema: z
      .object({
        customer_id: customerId,
        type: z.enum(tasks.TASK_TYPES).describe('Task type'),
        team: z.enum(tasks.TEAMS).describe('Owning team'),
        title: z.string().min(3).max(120),
        description: z.string().min(3).max(1000),
      })
      .strict(),
    run: ({ db, runId }, a) => tasks.createTask(db, a, runId),
  }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** JSON-schema declarations handed to the model. Built from the same Zod schemas we validate with. */
export function toolDeclarations(tools: ToolDef[] = TOOLS) {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    delete schema.additionalProperties;
    return { name: t.name, description: t.description, parametersJsonSchema: schema };
  });
}
