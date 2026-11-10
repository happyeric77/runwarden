# Governance playground

Sandbox shop, seed data, and MCP tools for later governance scenarios. This package is the foundation only. Agent, policy, and live feed arrive in later PRs.

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
