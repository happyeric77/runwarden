import type { DatabaseHandle } from 'runwarden';

export interface ClaimResult {
  claim: 'refund' | 'email';
  verified: boolean;
  evidence: string;
}

export async function checkClaims(
  db: DatabaseHandle,
  invocationId: string,
  replyText: string,
): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  if (/refund/i.test(replyText)) {
    const { rows } = await db.pool.query<{ id: string }>(
      `select id from agent_runtime.tool_call_audits
       where invocation_id = $1 and tool_name = 'issue_refund' and status = 'succeeded'
       order by id limit 1`,
      [invocationId],
    );
    results.push({
      claim: 'refund',
      verified: !!rows[0],
      evidence: rows[0]
        ? `audit ${rows[0].id}: issue_refund succeeded`
        : 'no succeeded issue_refund audit for this invocation',
    });
  }
  if (/email|sent/i.test(replyText)) {
    // ponytail: matching request fields cannot distinguish concurrent identical emails; add invocation IDs to sandbox rows if concurrent runs are supported.
    const { rows } = await db.pool.query<{
      id: string;
      email_id: string | null;
    }>(
      `select a.id, e.id as email_id
       from agent_runtime.tool_call_audits a
       left join sent_emails e on e.customer_id = a.request_snapshot->>'customerId'
         and e.subject = a.request_snapshot->>'subject'
         and e.body = a.request_snapshot->>'body'
       where a.invocation_id = $1 and a.tool_name = 'send_email_to_customer'
         and a.status = 'succeeded'
       order by e.id nulls last, a.id limit 1`,
      [invocationId],
    );
    const audit = rows[0];
    results.push({
      claim: 'email',
      verified: !!audit?.email_id,
      evidence: !audit
        ? 'no succeeded send_email_to_customer audit for this invocation'
        : audit.email_id
          ? `audit ${audit.id}: send_email_to_customer succeeded; sent_emails ${audit.email_id}`
          : `audit ${audit.id}: send_email_to_customer succeeded; no matching sent_emails row`,
    });
  }
  return results;
}

export function formatClaims(results: ClaimResult[]): string {
  return results
    .map(
      (result) =>
        `  ${result.claim}: ${result.verified ? 'VERIFIED' : 'CLAIM UNVERIFIED'} - ${result.evidence}`,
    )
    .join('\n');
}
