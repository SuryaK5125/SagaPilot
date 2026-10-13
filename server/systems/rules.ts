/**
 * Deterministic company policy. These rules are enforced in code by the
 * systems and the approval manager; the LLM can read them (get_company_rules)
 * but can never override them.
 */
export const COMPANY_RULES = [
  {
    id: 'R1',
    system: 'access',
    rule: "A workspace may only have entitlements that are included in its customer's current subscription plan. Enabling a feature outside the plan is rejected.",
  },
  {
    id: 'R2',
    system: 'access',
    rule: 'Entitlement changes require the workspace to be active. A suspended workspace can be reactivated only when the customer subscription status is active.',
  },
  {
    id: 'R3',
    system: 'billing',
    rule: 'Moving a customer to a lower-ranked plan (a downgrade) requires explicit human approval before it takes effect.',
  },
  {
    id: 'R4',
    system: 'tasks',
    rule: "Every plan upgrade needs an 'onboarding' task for the customer_success team. Every plan downgrade needs a 'transition' task for the account_management team.",
  },
  {
    id: 'R5',
    system: 'all',
    rule: 'Never report a change as done unless the system of record confirms it.',
  },
] as const;
