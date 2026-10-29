# Quickstart: one governed, durable invocation

The whole Runwarden story in one run, with a real model: a worker executes
two invocations out of Postgres, the model's tool calls go through a tiny
MCP server, and when the model reaches for an approval-gated refund,
policy parks the invocation in `awaiting_approval` until the script
approves it. Every ruling lands in the audit tables for you to inspect
at the end.

## Run it

From the repository root, with Node.js 22+, pnpm, and Docker Compose:

```sh
pnpm install --frozen-lockfile
export MODEL_API_KEY=sk-... # any OpenAI-compatible endpoint works
docker compose -f examples/quickstart/docker-compose.yml up -d --wait
pnpm quickstart
```

Optional: `MODEL_BASE_URL` (default `https://api.openai.com/v1`) and
`MODEL_ID` (default `gpt-4o-mini`). A local model server (Ollama, vLLM,
...) works too: point `MODEL_BASE_URL` at it and use any non-empty
`MODEL_API_KEY`.

That is all. The script creates the schema (`initDb`), starts a worker,
runs both invocations, prints the audit trail out of Postgres, and exits.

To reset afterwards:

```sh
docker compose -f examples/quickstart/docker-compose.yml down -v
```

## What you should see

1. **Story 1: a real lookup.** You ask for the roadmap note. The model
   calls `notes__search` through MCP, reads the result, and answers with
   what the note says. The invocation succeeds.
2. **Story 2: approval gate.** You ask for a refund of order 42, specifying
   5000 cents and the reason "duplicate charge", and request the refund tool. The
   model proposes `billing__refund`, which is listed in `requireApproval`.
   The call does not execute. The invocation parks in `awaiting_approval`
   with the proposed call stored on its row, and the request is recorded
   as `approval_requested`. The script then plays the host app: it lists
   the pending approval with `listPendingApprovals`, approves it with
   `approveInvocation`, and the worker reruns the invocation from the
   start. This time the exact approved call passes the gate, the refund
   executes, and the invocation succeeds. Approval reruns the whole
   invocation, so tool calls from earlier in the run can execute again;
   idempotency keys are what guard their side effects. Occasionally the
   model responds with text instead of proposing a tool call. In that
   case, the script prints its response and reports that nothing was
   intercepted, rather than claiming the gate blocked a call.
3. **The audit trail.** The script queries `agent_runtime.invocations`
   and `agent_runtime.policy_decisions` and prints both: statuses,
   attempt counts, and the ruling behind every step above.

The model's wording and whether it proposes a tool call vary from run to run.
Whenever it proposes `billing__refund`, the runtime gates that call; the final
summary follows the recorded evidence, and both invocations are always audited.

## What just happened, in library terms

- `defineRuntime({ db, provider, mcpServers, tools, policies })` assembled
  the runtime; `requireApproval: ['billing__refund']` is the whole
  governance configuration. The `provider` block is the only place a model
  is configured; change its `baseUrl` / `model` and nothing else moves.
- `runtime.invoke()` enqueued each invocation; `runWorker()` claimed it
  under lease and executed it. The worker runs in the same process here
  only to keep the quickstart to one command; in production it is its
  own process (see the [durable example](../durable/README.md), which
  splits app and worker into separate processes).
- Policy is enforced on the execution path by the runtime, not by asking
  the model nicely: a proposed gated tool call is stopped before the MCP
  server ever sees it.
- The approval flow is library API, not a UI: `listPendingApprovals`,
  `approveInvocation`, and `rejectInvocation` are the same calls a host
  app (an admin page, a CLI, a chat bot) would make. Approval requeues
  the invocation; rejection cancels it with `approval_rejected`.

Want the deterministic, no-key version of the policy story?
`pnpm demo` ([`examples/governed-invocation.ts`](../governed-invocation.ts))
runs the exactly-one correction loop in-process with a scripted model:
no database, no API key.
