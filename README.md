# durable-agent-runtime (working title)

> Final name TBD. This repository is private while the runtime is extracted from its original production codebase; it will open once the extraction is complete and the example runs end to end.

A lightweight, governed agent runtime for TypeScript. It runs on your own Postgres — no server to deploy, no hosted control plane.

Agent frameworks decide how an agent thinks. This runtime decides what an agent is **allowed to do**, proves it stayed inside those lines, and makes sure the run finishes even if the process dies.

## What it enforces

- **Tool-call policy, enforced by the runtime — not requested in the prompt.** Per-step call limits, allowlists, and a bounded correction budget. Rules the model cannot talk its way around.
- **Governance.** Per-scope capability grants: which tools a given agent may call at all, and which calls need a human approval first.
- **Audit.** Every invocation and every delegated tool call lands in your Postgres with a run-id you can trace end to end.

Durability is the substrate, not the headline: invocations are claimed by workers under lease with heartbeat and retry, so a crashed process resumes instead of losing work or double-executing.

## Shape (v1)

1. Core npm package: `defineRuntime({ db, provider, mcpServers, policies })`, `runtime.invoke()`
2. `npx <name> init` — creates the invocation + audit schema in your Postgres
3. `runWorker()` plus a docker-compose template
4. A 30-minute runnable example

## Durable mode

Pass a database and `invoke()` becomes durable: the invocation is queued in
Postgres and executed by any worker running `runWorker()` — under lease,
with heartbeat, retry, and crash recovery.

```sh
DATABASE_URL=postgres://... npx durable-agent-runtime init   # create tables (idempotent)
```

```ts
const db = createDb(process.env.DATABASE_URL);
const runtime = defineRuntime({ db, provider, policies });
runWorker({ runtime, db }); // in your worker process
await runtime.invoke({ scope: 'tenant-a', prompt: '...' }); // enqueue + wait
```

A runnable version with a docker-compose template (app + worker + postgres)
is in [`examples/durable`](examples/durable/README.md) — three steps from an
empty database to a completed invocation.

## What it is not

- Not an enterprise orchestration platform: no multi-region, no massive-throughput claims, no multi-day workflow orchestration.
- Not a framework: it sits under AI SDK / your agent loop, it does not replace how the agent thinks.
- Not hosted: your database, your workers, your audit trail.

## Status

Extraction in progress. The engine already runs in production inside its reference application; the work here is de-domain-ing it into a standalone library, consolidating the policy surface into a declarative API, and packaging schema + worker as described above.

## License

MIT — see [LICENSE](LICENSE).
