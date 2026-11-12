FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/runwarden/package.json packages/runwarden/package.json
COPY apps/governance-playground/package.json apps/governance-playground/package.json
RUN pnpm install --frozen-lockfile
COPY packages/runwarden/src packages/runwarden/src
COPY packages/runwarden/tsconfig.json packages/runwarden/tsdown.config.ts packages/runwarden/
COPY packages/runwarden/migrations packages/runwarden/migrations
COPY apps/governance-playground/src apps/governance-playground/src
COPY apps/governance-playground/tsconfig.json apps/governance-playground/tsconfig.json
RUN pnpm --filter runwarden build
WORKDIR /app/apps/governance-playground
CMD ["pnpm", "exec", "tsx", "src/feed.ts"]
