# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --filter @ucch/web...

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# the WebSocket origin has to be known here rather than at container start.
ARG NEXT_PUBLIC_WS_ORIGIN
ENV NEXT_PUBLIC_WS_ORIGIN=$NEXT_PUBLIC_WS_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/web
RUN pnpm exec next build

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
