# Durable mode example

The smallest durable setup: invocations are queued in Postgres, a worker
process claims and executes them under lease, and `invoke()` in the app
process waits for the result. Another worker can reclaim an expired lease.
Execution is at-least-once: work may repeat after a crash, so tool side effects
must use stable idempotency keys.

New here? Start with the [quickstart](../quickstart/README.md): the full
policy + audit story with a scripted model — no API key needed.

You need an OpenAI-compatible model endpoint. Set `MODEL_BASE_URL`,
`MODEL_API_KEY`, and `MODEL_ID` in your shell (defaults point at OpenAI).
Run from the repository root with Node.js 24+, pnpm 10.34.9, and Docker Compose
installed. Install dependencies first with `pnpm install --frozen-lockfile`.

## Three steps

1. **Start Postgres** (or point `DATABASE_URL` at any Postgres you own):

   ```sh
   docker compose -f examples/durable/docker-compose.yml up --wait postgres
   export DATABASE_URL=postgres://postgres:password@localhost:54329/durable_agent_runtime
   ```

2. **Create the runtime tables** (idempotent — safe to re-run):

   ```sh
   pnpm exec tsx src/cli.ts init
   ```

3. **Start the worker, then run the app**:

   ```sh
   pnpm exec tsx examples/durable/worker.ts   # terminal 1
   pnpm exec tsx examples/durable/app.ts "Give me a one-line summary of durable execution."   # terminal 2
   ```

The app prints the invocation id and the worker's result. The invocation,
its attempt count, and policy decisions are in your database
(`agent_runtime.invocations`, `agent_runtime.policy_decisions`).
