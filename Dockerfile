# syntax=docker/dockerfile:1

# Every image UCCH deploys, as build targets of one file:
#
#   server   the Fastify API, WebSocket, terminals and agent workers (3001)
#   web      the Next.js UI (3000), from Next's standalone output
#
# docker-compose.yml builds both; see "Deploying on Dokploy" in README.md.
#
# Debian rather than Alpine in every stage: `@lydell/node-pty` ships a
# glibc-linked prebuilt, and node_modules are copied between stages, so the
# build and runtime stages have to agree on libc.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# Manifests before sources so a code change does not invalidate the
# dependency layer. Every workspace package either app reaches through
# `workspace:*` has to be here, or pnpm cannot resolve the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
COPY packages/providers/package.json packages/providers/

# --- web ---------------------------------------------------------------------

FROM deps AS web-build
RUN pnpm install --frozen-lockfile --filter @ucch/web...
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
# Both are read when the build compiles next.config.ts's rewrite table, so
# they have to be known here. SERVER_ORIGIN is the server container on the
# compose network. NEXT_PUBLIC_WS_ORIGIN is *empty* on purpose: unset,
# next.config.ts would fall back to SERVER_ORIGIN and bake an internal
# hostname into the browser bundle; empty, the client opens its WebSocket on
# the page's own host, where Traefik sends /ws to the server.
ARG SERVER_ORIGIN=http://server:3001
ENV SERVER_ORIGIN=$SERVER_ORIGIN NEXT_PUBLIC_WS_ORIGIN=""
# Optional: the tldraw licence for the notes whiteboard.
ARG NEXT_PUBLIC_TLDRAW_LICENSE_KEY
ENV NEXT_PUBLIC_TLDRAW_LICENSE_KEY=$NEXT_PUBLIC_TLDRAW_LICENSE_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && pnpm exec next build

# Stateless: run as many replicas as the load needs (WEB_REPLICAS).
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# --- server ------------------------------------------------------------------

# Stateful: terminals, project files and the job workers live in this one
# process, so it runs as exactly one replica.
FROM base AS server
ENV NODE_ENV=production
# What the server shells out to, and what the user's projects need until the
# container runtime moves them out of this image:
#   git, bash, ripgrep      -- clone/commit/push, the terminal, code search
#   pandoc + typst          -- the agent's document tools; typst is the PDF
#                              engine (pandoc cannot write PDF alone)
#   php + composer          -- `php artisan serve` for Laravel projects
#   postgresql/mariadb clients -- psql / mysql against the dev databases
#   ca-certificates, curl   -- HTTPS from inside the terminal
#   tini                    -- PID 1: reaps zombies, forwards signals
ARG TYPST_VERSION=0.13.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ripgrep xz-utils pandoc tini \
    postgresql-client default-mysql-client \
    php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-pgsql php-mysql php-bcmath php-intl php-gd unzip \
  && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
     | tar -xJ --strip-components=1 -C /usr/local/bin "typst-x86_64-unknown-linux-musl/typst" \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
ENV SHELL=/bin/bash

COPY --from=deps /app ./
# NODE_ENV=production above would make pnpm skip devDependencies, and tsx
# (a root devDependency) is what runs the server.
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter @ucch/server...
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/db ./packages/db
COPY packages/agent ./packages/agent
COPY packages/providers ./packages/providers
COPY apps/server ./apps/server
COPY deploy/server-entrypoint.sh ./deploy/server-entrypoint.sh

# The server runs TypeScript directly through tsx rather than a build step.
# Its startup cost is milliseconds and it keeps one source of truth for the
# workspace packages, which are consumed as TypeScript everywhere else too.
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/app/deploy/server-entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
