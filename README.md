# Runwarden

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1)

**Agents act. Policies decide. Postgres remembers.**

A lightweight, governed agent runtime for TypeScript: enforced tool-call
policy and a per-call audit trail, durable on your own Postgres.

## Overview

<img width="900" alt="Runwarden policy gate: an agent proposes tool calls, Runwarden checks each one against policy, allowed calls execute through MCP tools, approval-gated calls are stopped, and every ruling is written to Postgres" src="assets/gate-overview.svg" />

Agent runs rarely fail by crashing. They fail by staying alive and doing
the wrong thing: picking the wrong tool, calling it twice, or reaching for
something sensitive nobody approved — while prompt-level rules ("never do
X") get quietly ignored by the model.

Runwarden puts the rules in the runtime instead of the prompt. You define
the runtime once — model, MCP tool servers, policies — and every tool call
the model proposes is checked against policy before it executes. Every
ruling is written to Postgres as an audit row. Underneath, invocations are
durable: queued in your database, claimed by workers under leases, retried
with backoff.

It is built for indie developers and solo founders putting agents in front
of real users — for the day your agent first does something wrong in front
of one of them.

DBOS gives you durable execution for workflows and functions. Runwarden's
headline is governing what an agent may do — enforced tool-call policy and
per-call audit — with durable execution as the substrate underneath.

## Features

- **Enforced tool-call policy** — exactly one tool call per model step, a
  tool allowlist, and per-tool input validation, all checked in the runtime
  between the model's proposal and execution. A violating call executes
  nothing.
- **Correction loop** — a denied call returns a correction the model can
  act on, within a bounded correction budget, instead of failing silently
  or looping forever.
- **Approvals, fail-closed** — list a tool in `requireApproval` and a
  proposal to call it is stopped and recorded as `approval_requested`.
  Nothing sensitive executes unapproved.
- **Audit trail in Postgres** — every invocation and every policy decision
  is a row in the `agent_runtime` schema, queryable with plain SQL.
- **Durable execution** — invocations are claimed by workers under leases
  with heartbeats, retried with backoff, and fenced so a stale worker
  cannot overwrite a newer attempt. Delivery is at-least-once; idempotency
  keys guard side effects.
- **MCP-first tools** — tools execute through MCP servers you run;
  Runwarden governs, the server executes.
- **Your database** — `runwarden init` creates the schema in your own
  Postgres. No hosted service, no separate state store.

## Quick Start

### Requirements

- Node.js 22 or newer
- pnpm 10
- Docker, to run Postgres for the example (or your own Postgres — set
  `DATABASE_URL` and skip the compose step)
- A model API key for any OpenAI-compatible endpoint (or a local model
  server — see the quickstart README)

```sh
git clone https://github.com/happyeric77/runwarden.git
cd runwarden
pnpm install
export MODEL_API_KEY=sk-... # any OpenAI-compatible endpoint
docker compose -f examples/quickstart/docker-compose.yml up -d --wait
pnpm quickstart
```

The quickstart runs the full story against a local MCP server with a
real model: a note lookup that executes through MCP, and a refund stopped
by `requireApproval` — then it prints both invocations and their policy decisions
from Postgres. Occasionally the model responds with text instead of proposing
the refund tool; the example reports that nothing was intercepted rather than
claiming a blocked call. The [quickstart README](examples/quickstart/README.md)
walks through each step and what you should see.

For the production-shaped setup — separate app and worker processes and a
real model provider — see [examples/durable](examples/durable/README.md).

## How It Works

1. You describe the runtime once with `defineRuntime`: the model, the MCP
   servers and tools it may use, and the policies that apply.
2. `invoke()` writes a durable invocation row to Postgres and waits for
   the outcome; `enqueue()` returns immediately instead.
3. A worker started with `runWorker()` claims queued invocations under a
   lease, heartbeating while it runs; expired leases are reclaimed.
4. At every model step, the proposed tool calls are checked against
   policy — exactly-one, allowlist, input validation, `requireApproval` —
   before anything executes through MCP.
5. Every ruling lands in `policy_decisions` and the invocation's state in
   `invocations`, so the whole run can be reconstructed from SQL.

All of it lives in four tables in the `agent_runtime` schema:

```mermaid
erDiagram
    invocations ||--o{ policy_decisions : "rules on"
    invocations ||--o{ tool_call_audits : "executes"

    invocations {
        bigint id PK
        text scope
        text conversation_id
        text ordering_key
        jsonb input
        text result_text
        text idempotency_key
        invocation_status status "pending | running | awaiting_approval | succeeded | failed | cancelled"
        int attempt_count
        int max_attempts
        timestamptz next_attempt_at
        timestamptz claimed_at
        text claimed_by
        timestamptz lease_heartbeat_at
        timestamptz lease_expires_at
        uuid active_run_id
        timestamptz active_run_registered_at
        jsonb pending_tool_call
        timestamptz started_at
        timestamptz completed_at
        timestamptz failed_at
        text provider
        text model
        text last_error_code
        text last_error_message
        jsonb metadata
        timestamptz created_at
        timestamptz updated_at
    }
    tool_call_audits {
        bigint id PK
        bigint invocation_id FK
        text scope
        uuid run_id
        text tool_name
        text idempotency_key
        tool_call_status status "started | succeeded | failed"
        timestamptz requested_at
        timestamptz completed_at
        text error_code
        jsonb request_snapshot
        jsonb metadata
        timestamptz created_at
    }
    policy_decisions {
        bigint id PK
        text scope
        bigint invocation_id FK
        uuid run_id
        text tool_name
        text rule
        text decision
        jsonb detail
        timestamptz created_at
    }
    worker_leases {
        text name PK
        text holder_id
        timestamptz acquired_at
        timestamptz heartbeat_at
        timestamptz expires_at
    }
```

`worker_leases` stands alone on purpose — it is a named-lock table; each
invocation's lease state lives on the invocation row itself.

The end of a quickstart run prints that trail — a typical run:

```text
[audit] what landed in Postgres:
  invocation <id>: status=succeeded attempts=1
  invocation <id>: status=failed attempts=1 error=approval_required
  policy_decision invocation=<id> rule=require_approval decision=approval_requested tool=billing__refund
```

## Limitations

- **Not for massive throughput:** Runwarden targets indie and solo scale —
  agents in front of your users, not a high-volume job platform.
- **Single region:** one Postgres is the state store. There is no
  multi-region story.
- **TypeScript only in v1:** the runtime, the policy surface, and the
  examples are TypeScript on Node.js.
- **Invocation-level durability only:** a crashed or expired invocation
  retries the whole run, at-least-once. There is no step-level
  checkpointing and no multi-day workflow orchestration.
- **Approvals are fail-closed, not resumable:** `requireApproval` stops
  the invocation with `approval_required` and records the request. An
  approve-and-rerun flow is a later slice; today, approving means
  re-running the invocation yourself.
- **Audit scope today:** invocations and policy decisions are recorded.
  The `tool_call_audits` table ships ahead of its writer, which lands in a
  later slice.
- **Not hosted, not enterprise-grade:** a library you run yourself.
  Isolation between your own workloads is a single `scope` string, not a
  multi-tenant control plane.

## Development

```sh
pnpm install
pnpm test              # unit tests
pnpm test:integration  # real Postgres via embedded-postgres
pnpm typecheck
pnpm format:check
pnpm demo              # in-process governed invocation, no database
```

## License

Runwarden is licensed under the [MIT License](LICENSE).
