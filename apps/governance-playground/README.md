# Governance playground

Sandbox shop for governance scenarios. Slice 1 runs governed refunds, Slice 2 adds a read-only live feed, and Slice 3 adds terminal approval. Free input comes later.

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

From the repo root, run `pnpm build` once. This app imports the built `runwarden` package. Then, from this directory:

```sh
docker compose up -d --wait
export DATABASE_URL=postgres://postgres:password@localhost:54331/governance_playground
export MODEL_BASE_URL=https://api.openai.com/v1
export MODEL_API_KEY=your-key
export MODEL_ID=gpt-4o-mini
pnpm play refund-three
```

`MODEL_BASE_URL` defaults to `https://api.openai.com/v1` and `MODEL_ID` defaults to `gpt-4o-mini`. `MODEL_API_KEY` is required. The scenarios are `refund-three` and `refund-large`.

The terminal prints each policy decision as it happens (`rule`, `decision`, `toolName`). The first step is denied and split. After the run, the process prints the assistant reply, then the new refund rows, the tool call audits for this invocation, and the exactly-one policy decisions.

## Slice 2: live feed

Build once from the repo root with `pnpm build`. Start the database as above, and set `DATABASE_URL` in both terminals. From this directory, start the feed in one terminal:

```sh
pnpm feed
```

Open http://localhost:43123. Set `FEED_PORT` to change the port. In a second terminal, set the model environment variables as in Slice 1 and run:

```sh
pnpm play refund-three
```

The read-only page refreshes every two seconds. When a model proposes a batch, deny decisions appear red, corrections yellow, and successful audits green as the run proceeds. The feed shows each invocation and audit's current state, not a complete history of their state changes.

Model behavior varies: in Eric's tests, gpt-6-luna did not batch calls, while qwen3.5 on Ollama did. Use a model that batches to see the split. Warm up a local Ollama model before running: a cold start can hit the 120-second limit.

## Slice 3: large refund approval

Build and start the database as above. Set `DATABASE_URL` in both terminals. In terminal A, run `pnpm feed` and open http://localhost:43123. In terminal B, set the model environment variables and run:

```sh
pnpm play refund-large
```

When the model proposes the $200 refund, the feed's Awaiting approval count rises to 1 and the pending panel shows `issue_refund` and its input. The terminal asks for y/n. Answer y to approve: the refund lands and the feed shows green approved and allow events. Answer n to reject: no refund lands. The feed is read-only; approval happens only in the terminal.

Refunds strictly greater than $50 require approval, while $50 does not. `delete_customer` always requires approval. Model behavior may vary.
