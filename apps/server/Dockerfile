# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# The workspace manifests are copied before the sources so that a code change
# does not invalidate the dependency layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @ucch/server...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/db ./packages/db
COPY apps/server ./apps/server

# The server runs TypeScript directly through tsx rather than a build step.
# Its startup cost is milliseconds and it keeps one source of truth for the
# workspace packages, which are consumed as TypeScript everywhere else too.
EXPOSE 3001
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
