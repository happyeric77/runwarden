# Runwarden

> This repository is private while Runwarden is prepared for its public release.

A governed agent runtime for TypeScript: tool-call policy is enforced by the
runtime — not requested in the prompt — every ruling is audited, and
invocations are durable on your own Postgres. Lightweight: no server to
deploy, no hosted control plane.

Agent frameworks decide how an agent thinks. Runwarden decides what an agent
is **allowed to do**, proves it stayed inside those lines, and makes sure the
run finishes even if the process dies.

## Quickstart

No API key needed — the model is scripted, and it misbehaves on purpose:

```sh
pnpm install --frozen-lockfile
docker compose -f examples/quickstart/docker-compose.yml up -d --wait
pnpm quickstart
```

You will watch an exactly-one violation get denied and corrected, an
approval-gated refund get stopped cold, and the audit trail print out of
Postgres at the end. Walkthrough:
[examples/quickstart](examples/quickstart/README.md).

## What it enforces

- **Tool-call policy, enforced on the execution path.** Per-step call limits
  (exactly one by default), tool allowlists, and a bounded correction budget.
  Rules the model cannot talk its way around.
- **Governance.** Per-scope capability grants: which tools a given scope may
  call at all, and which calls are gated on human approval. Gated calls fail
  closed today — they do not run, and the denial is recorded; the resumable
  approval flow is a later slice.
- **Audit.** Every invocation and every policy ruling lands in your Postgres
  (`agent_runtime.invocations`, `agent_runtime.policy_decisions`) with a
  run-id you can trace end to end. Per-tool-call audit rows are the next
  slice; their table already ships with the schema.

Durability is the substrate, not the headline: invocations are claimed by
workers under lease with heartbeat and retry, so a crashed process's work is
reclaimed instead of lost. Execution is at-least-once — tool side effects
should use stable idempotency keys.

## Shape (v1)

One npm package:

- `defineRuntime({ db, provider, mcpServers, policies })` assembles the
  runtime. `runtime.invoke()` executes in-process, or enqueues durably when
  a `db` is passed (plus `enqueue()` / `getInvocation()`).
- `runwarden init` creates the schema — four tables in a dedicated
  `agent_runtime` Postgres schema — with an idempotent migration ledger.
- `runWorker()` claims and executes the queue. Tools execute only through
  MCP servers you configure.
- Examples: the [quickstart](examples/quickstart/README.md) (scripted model,
  the full story in one command) and
  [durable mode](examples/durable/README.md) (separate app/worker processes,
  a real model provider).

## Durable mode

Pass a database and `invoke()` becomes durable: the invocation is queued in
Postgres and executed by any worker running `runWorker()` — under lease,
with heartbeat, retry, and crash recovery.

```sh
DATABASE_URL=postgres://user:password@localhost:5432/mydb npx runwarden init
```

```ts
const db = createDb(process.env.DATABASE_URL);
const runtime = defineRuntime({ db, provider, policies });
runWorker({ runtime, db }); // in your worker process
await runtime.invoke({ scope: 'my-app', prompt: '...' }); // enqueue + wait
```

## How it differs from DBOS

DBOS gives you durable execution for workflows and functions. Runwarden's
headline is governing what an agent may do — enforced tool-call policy and
per-call audit — with durable execution as the substrate underneath.

## What it is not

- Not for massive throughput: a shared Postgres queue with serial
  per-process execution is sized for indie workloads, not fleets.
- Not multi-region: one Postgres, one region.
- Not multi-language: TypeScript only in v1.
- Not a workflow platform: no multi-day orchestration, and durability is
  per invocation — no step-level checkpointing in v1.
- Not a framework: it sits under AI SDK / your agent loop; it does not
  replace how the agent thinks.
- Not hosted: your database, your workers, your audit trail.
- Not enterprise-grade: no SSO, no compliance certifications — policy,
  governance, and audit for people putting agents in front of real users,
  kept deliberately small.

## Status

Engine and durable layer are in and tested: 46 unit tests, and 18
integration tests against a real Postgres. Approval is fail-closed in v1 —
a gated call is denied, recorded, and the invocation fails; resumable
approvals, per-tool-call audit writing, and the packaged build (the bin is
currently a tsx script) land in later slices. The engine already runs in
production inside its reference application.

## License

MIT — see [LICENSE](LICENSE).
