# syntax=docker/dockerfile:1

# Debian rather than Alpine: `@lydell/node-pty` ships a glibc-linked prebuilt
# (`libc.so.6`) that will not load under musl, and the terminal is what runs
# the user's dev server for the live preview.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# The workspace manifests are copied before the sources so that a code change
# does not invalidate the dependency layer. Every workspace package the
# server reaches through `workspace:*` has to be here, or pnpm cannot resolve
# the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile --filter @ucch/server...

FROM base AS runtime
ENV NODE_ENV=production
# What the server shells out to, and what the user's projects need until the
# container runtime moves them out of this image:
#   git, bash, ripgrep      -- clone/commit/push, the terminal, code search
#   pandoc + typst          -- the agent's document tools; typst is the PDF
#                              engine (pandoc cannot write PDF alone)
#   php + composer          -- `php artisan serve` for Laravel projects
#   ca-certificates, curl   -- HTTPS from inside the terminal
ARG TYPST_VERSION=0.13.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ripgrep xz-utils pandoc \
    php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-pgsql php-mysql php-bcmath php-intl php-gd unzip \
  && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
     | tar -xJ --strip-components=1 -C /usr/local/bin "typst-x86_64-unknown-linux-musl/typst" \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
# The terminal is a login shell; without this it falls back to /bin/bash
# anyway, but being explicit keeps the user's PATH and prompt predictable.
ENV SHELL=/bin/bash

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/agent/node_modules ./packages/agent/node_modules
COPY --from=deps /app/packages/providers/node_modules ./packages/providers/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/db ./packages/db
COPY packages/agent ./packages/agent
COPY packages/providers ./packages/providers
COPY apps/server ./apps/server

# The server runs TypeScript directly through tsx rather than a build step.
# Its startup cost is milliseconds and it keeps one source of truth for the
# workspace packages, which are consumed as TypeScript everywhere else too.
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
