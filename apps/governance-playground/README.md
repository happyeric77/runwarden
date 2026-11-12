# Governance playground

An intentionally unruly agent meets Runwarden's real-time governance in a sandbox shop. All data is fictional and stored in local Postgres.

- A burst of three refunds is sent back to be called one at a time.
- A large refund is parked until a person approves or rejects it.
- A claimed email is checked against the audit trail and sandbox records.

## Quickstart

You need Node.js 22 or newer, pnpm, Docker with Compose, and an OpenAI-compatible model endpoint and API key. From the repository root:

1. Install host dependencies, build the core package for the host CLI, and start Postgres and the feed:

   ```sh
   pnpm install
   pnpm build
   docker compose -f apps/governance-playground/docker-compose.yml up -d --build
   ```

2. In the terminal where you will run the scenarios, export all five variables. Replace the model values with your endpoint, key, and model ID:

   ```sh
   export DATABASE_URL=postgres://postgres:password@localhost:54331/governance_playground
   export MODEL_BASE_URL=https://api.openai.com/v1
   export MODEL_API_KEY=your-key
   export MODEL_ID=your-model-id
   export FEED_PORT=43123
   ```

3. Open the feed in a browser:

   ```sh
   open http://localhost:43123
   ```

   On Linux use `xdg-open http://localhost:43123` instead. The feed runs in Compose; scenarios run in this host terminal.

4. Run the three-refund scenario:

   ```sh
   pnpm --filter governance-playground play refund-three
   ```

5. Run the approval and claim-check scenarios. Answer `y` or `n` when prompted for approval:

   ```sh
   pnpm --filter governance-playground play refund-large
   pnpm --filter governance-playground play email-claim
   ```

Stop the stack with `docker compose -f apps/governance-playground/docker-compose.yml down`. Each scenario resets the sandbox shop data before running; do not use this database for real data.

## Three refunds: split a burst

```sh
pnpm --filter governance-playground play refund-three
```

If the model proposes three calls together, the terminal shows `exactly_one` denies and a correction, followed by individual calls and refund/audit verification. The feed displays denies in red, corrections in yellow, and successful tool audits in green. The policy requires exactly one tool call per step; model behavior determines whether a burst actually occurs.

## Large refund: human approval

```sh
pnpm --filter governance-playground play refund-large
```

For the $200 refund, the terminal shows the proposed call and asks for `y` or `n`. Approving reruns the invocation; rejecting cancels it. The feed shows the pending approval and subsequent decisions. The `requireApproval` predicate gates refunds above $50 and every `delete_customer` call.

## Email claim: check the evidence

```sh
pnpm --filter governance-playground play email-claim
```

The terminal prints the assistant's reply, claim checks, and audit verification. If the assistant claims an email was sent without the evidence, the email claim is marked `CLAIM UNVERIFIED`; if the email was recorded, it can be `VERIFIED`. The feed shows actual tool audits, including `issue_refund` and, only if called, `send_email_to_customer`. This is an audit-based claim check, not a separate runtime policy; tool calls still pass through the policies below. The model may actually call the email tool instead of making an unsupported claim.

## Policy reference

| Policy           | Playground behavior                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------- |
| exactly-one      | Reject multiple tool calls in one model step and request a single call.                       |
| correctionBudget | Allow up to 3 corrections.                                                                    |
| allowlist        | Permit the nine playground tools only.                                                        |
| requireApproval  | Require approval for `issue_refund` amounts greater than $50 and all `delete_customer` calls. |
| maxToolCalls     | Limit each invocation to 12 tool calls.                                                       |
| maxDurationMs    | Limit each invocation to 120 seconds.                                                         |

## Model notes

Burst behavior varies by model: Eric observed that gpt-6-luna did not batch calls, while qwen3.5 on Ollama did. Warm up a local Ollama model first or its cold start may hit the 120-second limit. Set `MODEL_ID` to the exact ID listed by your endpoint's `/v1/models` response.

## Free input

Run `pnpm --filter governance-playground play ask "Your request here"` to submit your own request.

## Limitations

- Governance is invocation-level: approval reruns the entire invocation rather than resuming a step.
- No real emails are sent and no real cards are charged.
- The feed is read-only; approvals happen in the terminal.
- Claim checks look for simple keywords and matching evidence, not meaning or intent. Model output varies.
