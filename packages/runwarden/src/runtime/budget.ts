import { AgentRuntimeError } from '../contracts/errors.js';
import type { BudgetGrant } from '../contracts/policy.js';

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
}

function invalid(message: string): AgentRuntimeError {
  return new AgentRuntimeError('failure', message, {
    code: 'invalid_budget_grant',
  });
}

// Grants are additional quota for configured dimensions only. The same rules
// guard the approval API and the resumed run, so a corrupt persisted grant
// cannot silently raise an unlimited or unrelated limit.
export function validateBudgetGrant(
  grant: BudgetGrant | undefined,
  budget: BudgetLimits,
): BudgetGrant {
  if (!grant) throw invalid('A budget approval requires a grant');
  if (grant.maxTokens === undefined && grant.maxCostUsd === undefined) {
    throw invalid('A budget grant requires maxTokens or maxCostUsd');
  }
  if (grant.maxTokens !== undefined) {
    if (budget.maxTokens === undefined) {
      throw invalid('A maxTokens grant requires a configured maxTokens limit');
    }
    if (!Number.isSafeInteger(grant.maxTokens) || grant.maxTokens <= 0) {
      throw invalid('A maxTokens grant must be a positive safe integer');
    }
  }
  if (grant.maxCostUsd !== undefined) {
    if (budget.maxCostUsd === undefined) {
      throw invalid(
        'A maxCostUsd grant requires a configured maxCostUsd limit',
      );
    }
    if (!Number.isFinite(grant.maxCostUsd) || grant.maxCostUsd <= 0) {
      throw invalid('A maxCostUsd grant must be a positive finite number');
    }
  }
  return {
    ...(grant.maxTokens !== undefined ? { maxTokens: grant.maxTokens } : {}),
    ...(grant.maxCostUsd !== undefined ? { maxCostUsd: grant.maxCostUsd } : {}),
  };
}

export function accumulateBudgetGrants(
  current: BudgetGrant | undefined,
  grant: BudgetGrant,
): BudgetGrant {
  return {
    ...(current?.maxTokens !== undefined || grant.maxTokens !== undefined
      ? { maxTokens: (current?.maxTokens ?? 0) + (grant.maxTokens ?? 0) }
      : {}),
    ...(current?.maxCostUsd !== undefined || grant.maxCostUsd !== undefined
      ? { maxCostUsd: (current?.maxCostUsd ?? 0) + (grant.maxCostUsd ?? 0) }
      : {}),
  };
}

// Effective limit = configured limit + accumulated grants, per dimension.
export function effectiveBudgetLimits(
  budget: BudgetLimits,
  grants: BudgetGrant | undefined,
): BudgetLimits {
  const maxTokens =
    budget.maxTokens === undefined
      ? undefined
      : budget.maxTokens + (grants?.maxTokens ?? 0);
  const maxCostUsd =
    budget.maxCostUsd === undefined
      ? undefined
      : budget.maxCostUsd + (grants?.maxCostUsd ?? 0);
  if (maxTokens !== undefined && !Number.isSafeInteger(maxTokens)) {
    throw invalid('Effective maxTokens must be a safe integer');
  }
  if (maxCostUsd !== undefined && !Number.isFinite(maxCostUsd)) {
    throw invalid('Effective maxCostUsd must be a finite number');
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}
