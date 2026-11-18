# Budget approval demo

A terminal demo of a durable invocation that crosses a token budget, parks in
`awaiting_approval`, receives a grant, and resumes as a fresh run.

The model is a deterministic mock. Usage is fixed per step, and the MCP tool is
an in-process fake, so the demo needs no model endpoint or API key.

## Prerequisites

- Node.js 24+, pnpm 10.34.9, Docker Compose
- Run from `packages/runwarden`
- Install dependencies with `pnpm install --frozen-lockfile`

## Run it

Start Postgres:

```sh
docker compose -f examples/budget-approval/docker-compose.yml up --wait postgres
export DATABASE_URL=postgres://postgres:password@localhost:54332/runwarden_budget_demo
```

Auto-approve after the park (best for recording):

```sh
pnpm exec tsx examples/budget-approval/demo.ts --auto
```

Or approve interactively by pressing Enter:

```sh
pnpm exec tsx examples/budget-approval/demo.ts
```

`DEMO_PAUSE_MS` controls the pause between model steps and before approval
(default `1200`). Set it to `0` to remove the pauses.

## What you should see

```text
[setup] Postgres schema ready
[run] invoking with maxTokens=10; the first tool step crosses it
[run] step 1: +6 input, +5 output; cumulative 11/10 tokens, over by 1
[run] tool ledger__summarize executed via fake MCP
[budget] 80% warning tokens accumulated=11 limit=10
[budget] exceeded tokens accumulated=11 limit=10
[parked] worker parked invocation <id> for request <run-id>
[parked] invocation <id> status=awaiting_approval requestId=<run-id>
[parked] tokens: accumulated=11 limit=10 step=1
[parked] usage snapshot: input=6 output=5 total=11
[approved] --auto: approving after 1200ms with grant maxTokens=15
[approved] granted +15 tokens; effective limit is now 25. The worker resumes as a fresh run.
[run] step 1: +6 input, +5 output; cumulative 11/25 tokens
[run] tool ledger__summarize executed via fake MCP
[run] step 2: +6 input, +6 output; cumulative 23/25 tokens
[budget] 80% warning tokens accumulated=23 limit=25
[done] metrics providerCalls=2 toolCalls=1 totalMs=...
[done] worker marked invocation <id> succeeded
[done] invocation <id>: November ledger: 3 refunds, net -$42.00. No anomalies found.
[done] total usage: input=12 output=11 total=23 cost=unknown costIncomplete=true
```

The invocation ID and request ID are generated at runtime. Resume is a fresh
whole-run execution, so the first tool call runs again. The invocation keeps
its ordering key until it settles.
