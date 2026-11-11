# Governance playground

Sandbox shop for governance scenarios. Slice 1 runs one governed refund. Approval, live feed, and free input come later.

## Database

From this directory:

```sh
docker compose up -d --wait
export DATABASE_URL=postgres://postgres:password@localhost:54331/governance_playground
pnpm seed
```

Postgres is `postgres:16-alpine` on port 54331. Quickstart uses 54330 and the durable example uses 54329. Seed creates the runwarden schema, then the sandbox tables in `public`, then loads fixed rows. Running it again replaces those rows, so counts stay the same.

## MCP server

```sh
pnpm mcp
```

Listens at `http://127.0.0.1:43122/mcp`. Set `MCP_PORT` to use another port. Requires `DATABASE_URL`. Tools: `list_orders`, `get_order`, `list_customers`, `get_customer`, `list_products`, `issue_refund`, `send_email_to_customer`, `cancel_order`, `delete_customer`.

## Tests

```sh
pnpm test
```

Shop and seed tests use embedded Postgres. Compose is not required. `pnpm typecheck` and `pnpm format:check` cover the package.

## Slice 1: three refunds, split back to one call

The assistant is impatient and tries to refund three orders in one step. Policy sends that step back. The assistant then refunds one order at a time.

From this directory:

```sh
docker compose up -d --wait
export DATABASE_URL=postgres://postgres:password@localhost:54331/governance_playground
export MODEL_BASE_URL=https://api.openai.com/v1
export MODEL_API_KEY=your-key
export MODEL_ID=gpt-4o-mini
pnpm play refund-three
```

`MODEL_BASE_URL` defaults to `https://api.openai.com/v1` and `MODEL_ID` defaults to `gpt-4o-mini`. `MODEL_API_KEY` is required. Only the scenario name `refund-three` is accepted.

The terminal prints each policy decision as it happens (`rule`, `decision`, `toolName`). The first step is denied and split. After the run, the process prints the assistant reply, then the new refund rows, the tool call audits for this invocation, and the exactly-one policy decisions.
