# Quickstart: one governed, durable invocation

The whole Runwarden story in one run: a worker executes two invocations out
of Postgres while policy intercepts the model's mistakes — and every ruling
lands in the audit tables for you to inspect at the end.

No API key is needed. The model is scripted (`MockLanguageModelV4`), so it
makes the same three proposals on every run: first it breaks the
exactly-one-tool-call rule, then it asks for an approval-gated refund, and
finally it makes the one correct call. The tools live behind a tiny MCP
server in this directory (`notes__search`, `billing__refund`).

## Run it

From the repository root, with Node.js 24+, pnpm, and Docker Compose:

```sh
pnpm install --frozen-lockfile
docker compose -f examples/quickstart/docker-compose.yml up -d --wait
pnpm quickstart
```

That is all. The script creates the schema (`initDb`), starts a worker,
runs both invocations, prints the audit trail out of Postgres, and exits.

To reset afterwards:

```sh
docker compose -f examples/quickstart/docker-compose.yml down -v
```

## What you should see

1. **Story 1 — correction.** The model proposes two `notes__search` calls
   in one step. Policy denies the step (`rule=exactly_one decision=deny`),
   issues one correction, and the model retries with a single call, which
   executes through MCP. The invocation succeeds.
2. **Story 2 — approval gate.** The model proposes `billing__refund`,
   which is listed in `requireApproval`. The call is denied and recorded
   as `approval_requested`; the refund tool never executes and the
   invocation ends `failed` with code `approval_required`. That is
   fail-closed governance working as intended: in v1 there is no approval
   inbox yet, so a gated call simply does not run.
3. **The audit trail.** The script queries `agent_runtime.invocations`
   and `agent_runtime.policy_decisions` and prints both: statuses,
   attempt counts, and the ruling behind every step above.

## What just happened, in library terms

- `defineRuntime({ db, model, mcpServers, tools, policies })` assembled
  the runtime; `requireApproval: ['billing__refund']` is the whole
  governance configuration.
- `runtime.invoke()` enqueued each invocation; `runWorker()` claimed it
  under lease and executed it. The worker runs in the same process here
  only to keep the quickstart to one command — in production it is its
  own process (see the [durable example](../durable/README.md), which
  also shows a real model provider instead of the scripted one).
- Policy was enforced on the execution path by the runtime, not by
  asking the model nicely: the violating step executed zero tools, and
  the gated tool was stopped before the MCP server ever saw it.

The in-process counterpart — same policy story without Postgres — is
[`examples/governed-invocation.ts`](../governed-invocation.ts).
