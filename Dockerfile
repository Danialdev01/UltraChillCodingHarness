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
# The store lives in a BuildKit cache mount (see the installs below), so a
# changed lockfile downloads only what changed rather than everything.
ENV PNPM_STORE_DIR=/pnpm/store

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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @ucch/web...
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
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# --- server ------------------------------------------------------------------

# Stateful: terminals, project files and the job workers live in this one
# process, so it runs as exactly one replica.
FROM base AS server
ENV NODE_ENV=production
# What the server shells out to, and what the user's projects need until the
# container runtime moves them out of this image:
#   git, bash, ripgrep      -- clone/commit/push, the terminal, code search
#   php + composer          -- `php artisan serve` for Laravel projects
#   postgresql/mariadb clients -- psql / mysql against the dev databases
#   ca-certificates, curl   -- HTTPS from inside the terminal
#   tini                    -- PID 1: reaps zombies, forwards signals
# And the document pipeline behind the composer's Documentation mode
# (packages/agent/doc-kit). It is most of this image's size -- LibreOffice
# and Chromium alone are several hundred MB:
#   pandoc (release .deb)   -- Markdown in; bookworm's 2.17 has no Typst writer
#   typst + its packages    -- the PDF engine; fletcher/cetz cached so a
#                              compile never needs the network
#   python venv             -- python-docx, pypdf, pdfplumber, vl-convert
#   poppler-utils           -- pdftoppm (page renders), pdffonts (checks)
#   libreoffice-writer-nogui -- .doc/.odt/.rtf in, .docx -> .pdf out
#   graphviz, chromium + mermaid-cli -- diagrams
#   fonts-*                 -- the families templates/base.typ asks for
ARG TYPST_VERSION=0.13.1
ARG PANDOC_VERSION=3.6
ARG MERMAID_CLI_VERSION=11.4.2
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ripgrep xz-utils tini \
    postgresql-client default-mysql-client \
    php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-pgsql php-mysql php-bcmath php-intl php-gd unzip \
    python3 python3-venv poppler-utils libreoffice-writer-nogui graphviz chromium \
    fonts-inter fonts-ibm-plex fonts-jetbrains-mono fonts-noto-core fonts-dejavu-core \
  && curl -fsSL -o /tmp/pandoc.deb "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-amd64.deb" \
  && dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb \
  && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
     | tar -xJ --strip-components=1 -C /usr/local/bin "typst-x86_64-unknown-linux-musl/typst" \
  && rm -rf /var/lib/apt/lists/*
# The versions the doc kit's tests ran against. DOC_PYTHON points the server at it.
RUN python3 -m venv /opt/doc-venv \
  && /opt/doc-venv/bin/pip install --no-cache-dir \
    python-docx==1.1.2 pypdf==5.1.0 pdfplumber==0.11.4 vl-convert-python==1.7.0
ENV DOC_PYTHON=/opt/doc-venv/bin/python
# Chromium from apt rather than Puppeteer's download; doc_diagram.py points
# mmdc at it.
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm install -g "@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}" \
  && npm cache clean --force
# Typst reads packages from the running user's cache; the server runs as node.
RUN set -e; dir=/home/node/.cache/typst/packages/preview; \
  for pkg in fletcher/0.5.5 cetz/0.3.2 oxifmt/0.2.1; do \
    name=${pkg%/*}; version=${pkg#*/}; \
    mkdir -p "$dir/$name/$version"; \
    curl -fsSL "https://packages.typst.org/preview/$name-$version.tar.gz" | tar -xz -C "$dir/$name/$version"; \
  done; \
  chown -R node:node /home/node/.cache
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
ENV SHELL=/bin/bash

COPY --from=deps /app ./
# NODE_ENV=production above would make pnpm skip devDependencies, and tsx
# (a root devDependency) is what runs the server.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_ENV=development pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @ucch/server...
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/db ./packages/db
COPY packages/agent ./packages/agent
COPY packages/providers ./packages/providers
COPY apps/server ./apps/server
COPY deploy/server-entrypoint.sh ./deploy/server-entrypoint.sh

# The entrypoint starts as root only to read the root-only secret files, then
# drops to this user for the server and everything it spawns.
ENV UCCH_RUN_AS=node

# The server runs TypeScript directly through tsx rather than a build step.
# Its startup cost is milliseconds and it keeps one source of truth for the
# workspace packages, which are consumed as TypeScript everywhere else too.
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/app/deploy/server-entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
