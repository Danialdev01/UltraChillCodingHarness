# syntax=docker/dockerfile:1

# UCCH as one image: `app`, the last stage, so a plain `docker build .` --
# what Dokploy's "Dockerfile" build type runs -- produces it.
#
#   app      everything in one container: the API, WebSocket, terminals and
#            agent workers, the Next.js UI behind them, and PostgreSQL (plus
#            MariaDB with ENABLE_MYSQL=true), supervised by s6-overlay.
#            One port (3000), one volume (/data). See "Deploying on Dokploy"
#            in README.md, and documentation/architecture.md §8.
#
# Dokploy builds it on the VPS from this file (Build Type: Dockerfile). CI's
# .github/workflows/image.yml can build the same image instead and push it
# to GHCR, for an application that pulls it; see README.md.
#
# x86_64 only: pandoc, typst and s6-overlay are downloaded as amd64 builds.
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

# --- web build ---------------------------------------------------------------

FROM deps AS web-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @ucch/web...
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/web ./apps/web
# Both are read when the build compiles next.config.ts's rewrite table, so
# they have to be known here. SERVER_ORIGIN is where the API is from the web
# app's side: the server on the container's own loopback. NEXT_PUBLIC_WS_ORIGIN
# is *empty* on purpose: unset, next.config.ts would fall back to
# SERVER_ORIGIN and bake an internal address into the browser bundle; empty,
# the client opens its WebSocket on the page's own host.
ARG SERVER_ORIGIN=http://127.0.0.1:3000
ENV SERVER_ORIGIN=$SERVER_ORIGIN NEXT_PUBLIC_WS_ORIGIN=""
# Optional: the tldraw licence for the notes whiteboard.
ARG NEXT_PUBLIC_TLDRAW_LICENSE_KEY
ENV NEXT_PUBLIC_TLDRAW_LICENSE_KEY=$NEXT_PUBLIC_TLDRAW_LICENSE_KEY
# Optional: the share of page loads that report web vitals (lib/vitals.ts).
ARG NEXT_PUBLIC_VITALS_SAMPLE_RATE=1
ENV NEXT_PUBLIC_VITALS_SAMPLE_RATE=$NEXT_PUBLIC_VITALS_SAMPLE_RATE
# Optional: names this build (a commit sha, say). The browser bundle and the
# server below are given the same id, and a tab running another build than
# the server offers to reload (lib/app-update.ts). Unset, nothing compares.
ARG BUILD_ID=""
ENV NEXT_PUBLIC_BUILD_ID=$BUILD_ID
# Optional: 1 builds the service worker (src/app/sw.ts) into public/sw.js.
ARG NEXT_PUBLIC_PWA=0
ENV NEXT_PUBLIC_PWA=$NEXT_PUBLIC_PWA
ENV NEXT_TELEMETRY_DISABLED=1
# public/ exists either way, so the stages below can copy it.
RUN cd apps/web && mkdir -p public && pnpm exec next build

# --- server build ------------------------------------------------------------

# The server bundled into one file (apps/server/build.mjs), with only its
# production dependencies beside it: no tsx, no devDependencies at runtime.
FROM deps AS server-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @ucch/server...
COPY tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/db ./packages/db
COPY packages/agent ./packages/agent
COPY packages/providers ./packages/providers
COPY apps/server ./apps/server
RUN cd apps/server && node build.mjs
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ucch/server --prod deploy --legacy --store-dir /pnpm/store /out/server \
  && rm -rf /out/server/src \
  && cp -r apps/server/dist /out/server/dist \
  && cp -r packages/db/migrations /out/server/migrations \
  && cp -r packages/agent/doc-kit /out/server/doc-kit

# --- toolchain ---------------------------------------------------------------

# What the server shells out to, and what the user's projects need until the
# container runtime moves them out of this image:
#   git, bash, ripgrep      -- clone/commit/push, the terminal, code search
#   php + composer          -- `php artisan serve` for Laravel projects
#   postgresql/mariadb clients -- psql / mysql against the dev databases
#   ca-certificates, curl   -- HTTPS from inside the terminal
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
#   fonts-*                 -- the families templates/base.typ asks for (IBM
#                              Plex, its fallback, is not packaged for bookworm)
FROM base AS toolchain
ENV NODE_ENV=production
ARG TYPST_VERSION=0.13.1
ARG PANDOC_VERSION=3.6
ARG MERMAID_CLI_VERSION=11.4.2
# Fail with a reason, not a 404 or an exec format error further down.
RUN [ "$(dpkg --print-architecture)" = amd64 ] \
  || { echo "UCCH's image is x86_64 only (pandoc, typst and s6-overlay are amd64 downloads)" >&2; exit 1; }
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git ripgrep xz-utils \
    postgresql-client default-mysql-client \
    php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-pgsql php-mysql php-bcmath php-intl php-gd unzip \
    python3 python3-venv poppler-utils libreoffice-writer-nogui graphviz chromium \
    fonts-inter fonts-jetbrains-mono fonts-noto-core fonts-dejavu-core \
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
# OMP (oh-my-pi), the agent behind the "Custom" provider
# (documentation/architecture.md §7). The release binary, not the install
# script: the script resolves the file through a second service, and prefers
# a Bun install whenever Bun is on PATH. The binary is self-contained (glibc
# only). Bumping it is OM8.6: version, checksum and the recorded fixtures
# together.
#
# OMP unpacks ~120 MB of native modules on first start into $HOME/.omp, once
# per HOME -- and every subject's run has its own. PI_NATIVES_DIR points them
# all at one copy, unpacked here (OMP only reads it once it exists).
ARG OMP_VERSION=18.14.1
ARG OMP_SHA256=02d76a0cfeee473ffa387f50cf0378b0de1c44684c83e67ca27ba4d717cfb0d0
ENV OMP_SKIP_SETUP=1 \
    PI_NATIVES_DIR=/opt/omp/natives \
    OMP_BIN=/opt/omp/bin/omp
RUN set -eux; \
  mkdir -p /opt/omp/bin; \
  curl -fsSL -o /opt/omp/bin/omp \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64"; \
  echo "${OMP_SHA256}  /opt/omp/bin/omp" | sha256sum -c -; \
  chmod 755 /opt/omp/bin/omp; \
  test "$(/opt/omp/bin/omp --version)" = "omp/${OMP_VERSION}"; \
  HOME=/tmp/omp-warm /opt/omp/bin/omp config get autoResume >/dev/null; \
  test -d "/opt/omp/natives/${OMP_VERSION}"; \
  rm -rf /tmp/omp-warm
ENV PATH=/opt/omp/bin:$PATH
# Language servers for OMP's `lsp` tool (solution §8.2, OM7.4): TypeScript
# and Python. They start only for a trusted project; every other turn runs
# `--no-lsp`, because a repository's own LSP config is a command (§0.3). A
# project's own node_modules/.bin copy wins over these when it has one.
# TypeScript stays on 5.x: 7.x is the native compiler, which ships no
# tsserver for typescript-language-server to drive.
ARG OMP_LSP_TS_SERVER_VERSION=6.0.2
ARG OMP_LSP_TYPESCRIPT_VERSION=5.9.3
ARG OMP_LSP_PYRIGHT_VERSION=1.1.414
RUN npm install -g \
    "typescript-language-server@${OMP_LSP_TS_SERVER_VERSION}" \
    "typescript@${OMP_LSP_TYPESCRIPT_VERSION}" \
    "pyright@${OMP_LSP_PYRIGHT_VERSION}" \
  && npm cache clean --force \
  && test "$(typescript-language-server --version)" = "${OMP_LSP_TS_SERVER_VERSION}" \
  && command -v pyright-langserver \
  && pyright --version
# Debug adapters for OMP's `debug` tool (solution §8.3, OM7.5), trusted
# projects only (§0.3). debugpy in a venv of its own. OMP's built-in adapter
# runs `python -m debugpy.adapter` and the image has no `python`, so a
# user-scope dap.json moves its command to the venv's (an override merges
# into the built-in, so arguments and launch defaults stay OMP's). OMP reads
# that file from $HOME/.omp/agent/ only, never from PI_CODING_AGENT_DIR
# (measured, 18.14.1), and the server runs with HOME=/home/node. js-debug is
# the vscode-js-debug DAP server, a release tarball rather than an npm
# package, found through JS_DEBUG_DAP_SERVER.
ARG OMP_DAP_DEBUGPY_VERSION=1.8.22
ARG OMP_DAP_JS_DEBUG_VERSION=1.140.0
ARG OMP_DAP_JS_DEBUG_SHA256=27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968
RUN set -eux; \
  python3 -m venv /opt/debugpy; \
  /opt/debugpy/bin/pip install --no-cache-dir "debugpy==${OMP_DAP_DEBUGPY_VERSION}"; \
  test "$(/opt/debugpy/bin/python -c 'import debugpy; print(debugpy.__version__)')" = "${OMP_DAP_DEBUGPY_VERSION}"; \
  mkdir -p /opt/js-debug; \
  curl -fsSL -o /tmp/js-debug.tar.gz \
    "https://github.com/microsoft/vscode-js-debug/releases/download/v${OMP_DAP_JS_DEBUG_VERSION}/js-debug-dap-v${OMP_DAP_JS_DEBUG_VERSION}.tar.gz"; \
  echo "${OMP_DAP_JS_DEBUG_SHA256}  /tmp/js-debug.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/js-debug.tar.gz -C /opt/js-debug; \
  rm /tmp/js-debug.tar.gz; \
  test -f /opt/js-debug/js-debug/src/dapDebugServer.js; \
  mkdir -p /home/node/.omp/agent; \
  printf '%s\n' '{ "adapters": { "debugpy": { "command": "/opt/debugpy/bin/python" } } }' \
    > /home/node/.omp/agent/dap.json; \
  chown -R node:node /home/node/.omp
ENV JS_DEBUG_DAP_SERVER=/opt/js-debug/js-debug/src/dapDebugServer.js
# Claude Code and Codex, the subscription providers. The server finds them on
# PATH (CLAUDE_BIN, CODEX_BIN); each person signs in from Settings -> Providers
# and the login lands in /data/creds, so a rebuild keeps it. Installed as root
# and run as node, which cannot write here, so Claude Code's self-update is off
# and bumping these versions is how either CLI changes. They need
# AGENT_ALLOW_HOST_SHELL=true at runtime (.env.example sets it).
ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
  && codex --version | grep -F "${CODEX_VERSION}"
ENV SHELL=/bin/bash

# --- app: the single container ----------------------------------------------

FROM toolchain AS app
ARG S6_OVERLAY_VERSION=3.2.3.2
# s6-overlay: PID 1, starts the services in deploy/s6 in dependency order and
# stops them in reverse, giving the server a minute to drain its workers.
RUN set -eux; \
  for part in noarch x86_64; do \
    curl -fsSL -o "/tmp/s6-$part.tar.xz" \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-$part.tar.xz"; \
    tar -C / -Jxpf "/tmp/s6-$part.tar.xz"; \
    rm "/tmp/s6-$part.tar.xz"; \
  done
# PostgreSQL 16 from PGDG -- the version the old stack's volumes were made
# with -- and MariaDB from Debian for projects' MySQL dev databases. Neither
# package may create a database of its own: /data holds the only ones.
RUN set -eux; \
  mkdir -p /etc/postgresql-common /usr/share/postgresql-common/pgdg; \
  echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf; \
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 mariadb-server; \
  rm -rf /var/lib/apt/lists/* /var/lib/mysql/*

WORKDIR /app
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=server-build /out/server ./server
COPY deploy/s6/ /etc/s6-overlay/
COPY deploy/bin/ /usr/local/bin/
RUN chmod +x /etc/s6-overlay/scripts/* /etc/s6-overlay/s6-rc.d/*/run /usr/local/bin/ucch-*

# The same id the web build was given (see web-build).
ARG BUILD_ID=""
ENV DATA_DIR=/data \
    BUILD_ID=$BUILD_ID \
    S6_KILL_GRACETIME=60000 \
    S6_SERVICES_GRACETIME=60000 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=300000 \
    S6_VERBOSITY=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1
ENTRYPOINT ["/init"]
