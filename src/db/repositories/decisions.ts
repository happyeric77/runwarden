import type { PolicyDecision } from '../../contracts/policy';
import type { Database } from '../client';
import { policyDecisions } from '../schema';

export async function insertPolicyDecision(
  db: Database,
  decision: PolicyDecision,
): Promise<void> {
  await db.insert(policyDecisions).values({
    scope: decision.scope,
    invocationId: Number(decision.invocationId),
    runId: decision.runId,
    toolName: decision.toolName ?? null,
    rule: decision.rule,
    decision: decision.decision,
    detail: decision.detail ?? null,
  });
}
