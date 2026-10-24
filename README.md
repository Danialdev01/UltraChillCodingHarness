# UCCH — Ultra Chill Coding Harness

A cloud coding harness. Clone a GitHub repository into a container, run it, point an AI agent at it, watch the diff, commit, and publish a shareable live preview — all from the browser.

Built for **HTML, PHP, Laravel, React (Vite), and Next.js**. Deployed on a Dokploy VPS.

> **Status: Phase 1 of 8.** The event-sourced server, wire protocol, database, authentication, and web shell are built and verified. Containers, the routing gateway, the agent, and previews are specified but not yet implemented — see [Current status](#current-status). The architecture and remaining phases are in [`documentation/plan.md`](documentation/plan.md).

---

## How it works

### The shape of the system

```
                    Cloudflare DNS  *.ucch.danialirfan.dev
                              │
                    ┌─────────▼─────────┐
                    │ Traefik (Dokploy) │  wildcard TLS via DNS-01
                    └─────────┬─────────┘
                    ┌─────────▼─────────┐
                    │     gateway       │  subdomain → container:port
                    └────┬─────────┬────┘
                         │         │
       ┌─────────────────▼──┐   ┌──▼──────────────────────────┐
       │  web (Next.js UI)  │   │  project containers (N)     │
       └─────────┬──────────┘   │    ucch-proj-{hash}         │
                 │ WSS /ws      │    ucch-preview-{hash}      │
       ┌─────────▼──────────┐   └──▲──────────────────────────┘
       │  server (Fastify)  │──────┘ docker exec
       │   event log        │
       │   agent loop       │   ┌──────────────┐
       │   orchestrator     │──▶│  Postgres    │
       └────────────────────┘   └──────────────┘
                 │
       /srv/ucch/workspaces/{projectId}   ← bind-mounted into containers
```

**The server is the execution boundary.** Every container operation, terminal, git command, and file read happens on the server. The browser renders events and diffs; it never executes anything and holds no independent model of the world. `server` is the only process with the Docker socket and the Anthropic API key.

### Workspaces, projects, sub-agents

Work is organised as **user → workspaces → projects → sub-agents**. A workspace is a company or team container; you switch between them from the dropdown at the top of the sidebar, and create new ones from the same menu. Every account gets a "Personal" workspace on first sign-in, so the switcher is never empty.

Projects are created *into* a workspace, and that boundary is enforced server-side: a project can only be created in a workspace you own.

### Everything is an event

The browser never writes state directly. It sends a **command**; the server decides what actually happened and appends **events**:

```
Command  →  decide(state, command) → Event[]     ← pure function, no I/O
         →  ONE transaction: update read model, append events
         →  commit, then publish to subscribers
         →  reactors perform side effects → more events
```

The `events` table is the single source of truth; every other table is a projection that could be rebuilt by replaying it. Three consequences worth knowing:

- **`decide()` is pure** — no database, clock, or randomness. Every rule about what the system will and won't do lives in one exhaustively testable function.
- **Intent is separable from outcome.** A decision records `container.state_changed: creating`; the reactor records what actually resulted. Both are in the log.
- **Threads can be resumed, forked, and replayed** for free, because everything the model saw — system prompts, context injections, tool calls, results — is in the log.

### Talking to the server

One authenticated WebSocket carries commands up and events down. Authentication happens once at the upgrade, but **authorization is per-command**: holding a valid socket is not permission to call everything on it.

Because a browser can't set headers on a WebSocket handshake, the client exchanges its session cookie for a **short-lived, single-use ticket** over HTTPS and spends that on the upgrade. A long-lived token in a query string would leak into proxy logs and `Referer` headers; a ticket that's worthless once spent doesn't.

### Why URLs look like `p3000-a1b2c3d4e5f6.ucch.danialirfan.dev`

When you run `php artisan serve` in a project, that port becomes publicly reachable at its own subdomain:

| URL                        | What it is                            |
| -------------------------- | ------------------------------------- |
| `ucch.danialirfan.dev`   | the web app                           |
| `p3000-{projectHash}...` | port 3000 of that project's container |
| `pv-{previewHash}...`    | a published, frozen preview           |

The obvious alternative — `/{hash}/port:3000/...` — breaks every target framework. Laravel emits `/build/app.css`, Vite emits `/@vite/client`, Next.js emits `/_next/static/...`; all absolute, all missing the prefix. HMR sockets are built from `location.origin`, and SPA routers destroy the prefix on the first client-side navigation. Making that work needs an HTML-rewriting proxy plus per-framework base-path hacks, and still leaks. Subdomains remove the problem entirely, and isolate cookies per project as a bonus.

The path form still works — it 302s to the subdomain.

### Live preview of a running dev server

Open a project, start its dev server in the built-in terminal (`php artisan serve --port=8001`, `npm run dev`, anything that binds a port), then press the globe button in the top bar and enter the port. You get two addresses:

- **Share:** `https://ucch.danialirfan.dev/{hash}/preview` — the entry point. It checks that you own the project and forwards you on; `/{hash}/preview/dashboard` lands on the app's `/dashboard`.
- **App origin:** `https://p8001-{hash}.ucch.danialirfan.dev` — where the app is actually served, and what it sees as its own origin.

Only the project's owner can open it: the entry point mints a single-use ticket, and the preview host swaps it for its own cookie (the session cookie never leaves the root domain). The proxy only ever connects to the port stored on the project — the hostname is checked against it, so a preview cookie for one project cannot reach any other port on the host. HTTP and WebSocket upgrades are both proxied, so Vite HMR works; Vite 6 and later must allow the hostname (`server.allowedHosts: true` in `vite.config`).

Locally the address is `http://p8001-{hash}.ucch.localhost:3001` — `*.ucch.localhost` resolves to 127.0.0.1 on Linux, and `PUBLIC_PREVIEW_PORT=3001` puts the server's port on the URL because nothing sits in front of it.

### Reverting is honest

Every agent turn is bracketed by a workspace snapshot stored as a hidden git ref (`refs/ucch/checkpoints/{thread}/{turn}`), captured through a temporary index so it never disturbs your HEAD, branch, staged changes, or stash. Reverting a turn rolls back **files and conversation together** — rolling back the chat while leaving modified files on disk is the specific failure this design exists to prevent.

### What the agent can and cannot do

The agent runs as a streaming loop against the Claude API with a plugin tool registry — `read_file`, `edit_file`, `glob`, `grep`, `bash`, `git_commit`, and so on. **Every tool executes inside the project container** via `docker exec`; the server never touches workspace files directly, so a rogue command is confined to the container.

There is deliberately **no `git_push` tool**. The agent can commit; only a person can push. Commits land on a `ucch/{thread}` branch, so `main` is never written to by accident.

### Research

The **+** menu in the chat has a **Research** toggle. While it is on, each message runs a research turn instead of a coding one: the same loop, with a different prompt and a different tool set, in a fixed order of escalation.

1. **Find** — `research_search` is [Perplexity Sonar](https://openrouter.ai/perplexity/sonar) through OpenRouter, billed to your own key like any other model. One call returns an answer, the URLs it drew on, and a line on each.
2. **Read** — `research_read` is a [Crawl4AI](https://github.com/unclecode/crawl4ai) server: a headless-browser crawler that returns a page as markdown, fast enough to run on several URLs at once. Every URL goes through it first.
3. **Browse** — `research_browse` is a [Browser Use](https://browser-use.com) agent, a model driving a real browser. `research_read` escalates to it on its own when the crawler hits a bot check, a login wall or a 403, and the model can send it directly to a page that needs clicking through.

Set `CRAWL4AI_URL` and `BROWSER_USE_API_KEY` to enable the second and third steps (`docker run -d -p 11235:11235 --shm-size=1g unclecode/crawl4ai` is the crawler); without them the tools say what is missing rather than failing obscurely.

On the native harness the research *is* the turn. On **Claude Code or Codex** — which bring their own tools — a research message runs in two phases under one turn: the pipeline runs first on OpenRouter, using the default model from Settings (or the server's `DEFAULT_MODEL`), and writes a brief; the CLI is then given your message with the brief appended as source material. The brief is recorded as a `context.injected` event and the phase's cost is folded into the turn's usage. The toggle works on any thread, including one that has been running under a CLI for a while.

### Documentation

Beside Research in the **+** menu (or `/documentation`) is **Documentation**: a mode for creating, editing and reading documents — mostly PDF, DOCX and DOC. Only one mode is on at a time.

The model writes content and the templates own layout. A new document is Markdown with `type:` in its front matter (`report`, `spec`, `api-reference`, `proposal`, `runbook`, `memo`). Each type is a preset over one Typst template in `packages/agent/doc-kit/templates/base.typ`, so the model never sets margins, fonts or colours. The turn gets typed tools instead of a shell:

| tool | does |
|---|---|
| `doc_read` | text, headings, tables and figures of a .pdf/.docx/.doc, with paragraph anchors |
| `doc_inspect` | renders pages (or pulls out embedded figures) and asks a vision model (`DOC_VISION_MODEL`) a question, or reviews layout against a fixed rubric |
| `doc_edit` | in-place .docx edits that keep the document's styles; PDF forms, pages and metadata |
| `doc_render` | Markdown → Pandoc → Typst → PDF (or .docx/.html); ` ```mermaid `, ` ```dot ` and ` ```vega-lite ` fences become figures |
| `doc_diagram`, `doc_chart` | one diagram or chart to SVG/PNG, cached by content |
| `doc_check` | the deterministic checks: page budget, embedded fonts, links, overflow, captions, outline |
| `doc_skill` | loads one of the skills in `doc-kit/skills/` (planning, style, rendering, diagrams, charts, layout QA, citations, accessibility, editing) |

A new document runs render → `doc_check` → `doc_inspect` → patch → re-render, with at most two review rounds. Three failed renders of one file stop the repair loop. On **Claude Code or Codex**, the message is handed over with the same rules and the scripts' paths, for the CLI to run with its own shell.

The toolchain is in the server image. To run it locally you need pandoc ≥ 3, typst, poppler-utils, LibreOffice, graphviz, `@mermaid-js/mermaid-cli`, and a Python with the kit's packages:

```bash
python3 -m venv ~/.ucch-doc-venv
~/.ucch-doc-venv/bin/pip install python-docx==1.1.2 pypdf==5.1.0 pdfplumber==0.11.4 vl-convert-python==1.7.0
# then set DOC_PYTHON to that venv's absolute path, e.g. /home/you/.ucch-doc-venv/bin/python, in .env
```

Running `DOC_PYTHON=… pnpm test` also runs the scripts' own tests, which are skipped without it.

---

## Running it locally

### Requirements

Node 22+, Docker. pnpm comes through corepack. For the agent's document generation, `pandoc` and `typst` on PATH (the server image installs both; locally, `sudo pacman -S pandoc-cli typst`, `brew install pandoc typst`, or your distribution's equivalent).

### One line

```bash
corepack enable && pnpm dev:up
```

([`scripts/dev.sh`](scripts/dev.sh)) does, in order:

1. creates `.env` from `.env.development.example` if there isn't one, with a fresh `SECRET_KEY` and `DATABASE_URL` pointing at the dev database;
2. `pnpm install`;
3. starts PostgreSQL on `localhost:55432` from [`docker-compose.dev.yml`](docker-compose.dev.yml) and waits until it is healthy (if you already have the older `ucch-pg-dev` container, it starts that one instead, so your data stays);
4. runs the API server (:3001) and the web UI (:3000) with hot reload. Migrations apply on server boot.

Open **http://localhost:3000**. Ctrl-C stops the app; `pnpm dev:down` stops the database too. Want a dev MySQL as well? `docker compose -f docker-compose.dev.yml --profile mysql up -d` (port 53306, user/password `dev`).

The defaults in `.env.development.example` are for local work; `.env.example` is the production file for Dokploy. To run the two services in separate terminals instead, use `pnpm --filter @ucch/server dev` and `pnpm --filter @ucch/web dev`.

### Signing in

The server seeds a default account on first boot:

|                    |                                 |
| ------------------ | ------------------------------- |
| **Email**    | `danialirfan@danialirfan.dev` |
| **Password** | `danialdev`                   |

Set by `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD`. The account is only created when that email is unused, so restarting never resets a password you have changed — and **changing the password means editing it in the database, not in `.env`.** Change it before exposing the server.

Once in, the sidebar shell loads with the live connection badge; creating a project streams events into the log panel.

There are three ways to authenticate, and the server refuses to start unless at least one is configured — a server nobody can enter is a startup error, not a runtime surprise:

- **Password** — the seeded account above
- **GitHub OAuth** — the "Continue with GitHub" button, once `GITHUB_CLIENT_ID`/`SECRET` are set
- **`DEV_AUTH_BYPASS=true`** — skips authentication entirely and treats every request as a fixed local user. Handy for protocol work; the server **refuses to start** with it enabled when `NODE_ENV=production`, because an unauthenticated harness holding a Docker socket is a root shell on the host.

### Local wildcard domains

`*.ucch.localhost` resolves to `127.0.0.1` automatically on Linux, so subdomain routing works locally with no `/etc/hosts` entries once the gateway lands in Phase 3.

### Checks

```bash
pnpm test                        # 59 unit tests
pnpm typecheck                   # all four packages
node scripts/smoke-phase1.mjs    # end-to-end against a running server
```

The smoke script drives a real client through the whole protocol: health, authentication, ticket issue, WebSocket connect, `ready` frame, heartbeat, malformed-frame rejection, a `project.create` command, authorization failure, subscription, and a live push. Point it anywhere:

```bash
UCCH_BASE=https://api.ucch.danialirfan.dev node scripts/smoke-phase1.mjs
```

### About previews

Two different things share the word "preview":

- **Previewing your work on UCCH itself** — that's the local run above.
- **The live preview** (`p{port}-{hash}.ucch.danialirfan.dev`) of a dev server you started in a project's terminal — described above, and working.
- **Published previews** (`pv-{hash}.ucch.danialirfan.dev`), where UCCH builds a project from a specific commit into a frozen container you can share. That's **Phase 7** and is not implemented yet. It is specified in [`documentation/plan.md` §6.6](documentation/plan.md), including the per-stack build recipes.

---

## Deploying on Dokploy

UCCH deploys as **one container**: a Dokploy **Application** built from the [`Dockerfile`](Dockerfile), with one port, one volume and one click to deploy. Inside it, [s6-overlay](https://github.com/just-containers/s6-overlay) starts and supervises:

| Service | What it is | Where |
| --- | --- | --- |
| `server` | API, WebSocket, terminals, agent workers, **and the public port**: it serves `/api` and `/ws` itself and streams everything else to the UI ([`web-proxy.ts`](apps/server/src/web-proxy.ts)) | `0.0.0.0:3000` |
| `web` | Next.js UI (standalone build) | `127.0.0.1:3100` |
| `postgres` | PostgreSQL 16: the harness's own data (database `ucch`) and a `dev` user for your projects. Skipped when `DATABASE_URL` is set | `127.0.0.1:5432` |
| `mysql` | MariaDB for projects' MySQL dev databases, **only with `ENABLE_MYSQL=true`** | `127.0.0.1:3306` |

Everything stateful lives under **`/data`**: `postgres/`, `mysql/`, `workspaces/` (project files), `creds/` (CLI logins), `secrets/` (generated passwords and keys) and `backups/`. You don't generate passwords, wire services together or write Traefik config.

### 1. Before you start

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`), ports 80 and 443 open. 2 vCPU / 4 GB RAM is comfortable (the first build compiles Next.js).
- A domain for UCCH, e.g. `ucch.example.com`, with a DNS **A record** pointing at the VPS. For live previews also add `*.ucch.example.com` (see [Live previews](#live-previews-optional-one-time)). On Cloudflare, set both to **DNS only** (grey cloud).
- This repository on GitHub (or any Git URL Dokploy can reach).

### 2. Deploy

1. **Projects → Create Project** → `ucch`.
2. Inside it: **Create Service → Application**. **Provider**: this repository, branch `main`. **Build Type**: **Dockerfile**, path `Dockerfile`. The last stage, `app`, is the default; set **Docker Build Stage** to `app` if your Dokploy version asks.
3. **Environment**: paste [`.env.example`](.env.example) and set **`ROOT_DOMAIN`**. That is the only required value. Setting `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` for your first login is recommended.
4. **Domains**: add `ROOT_DOMAIN` → container port **3000**, HTTPS on, certificate Let's Encrypt.
5. **Advanced → Volumes**: a volume mounted at **`/data`**.
6. **Advanced → Swarm Settings → Update Config**: set **`Order` to `stop-first`**. **This matters**: the default start-first rollout would run two containers, so two PostgreSQL servers, on one data directory, and corrupt it.
7. **Deploy**. The first build takes ~10 minutes; later ones reuse the cache.

Check it:

```bash
curl -s https://ucch.example.com/health                                 # {"status":"ok",...,"db":"ok","web":"ok"}
curl -o /dev/null -w '%{http_code}\n' https://ucch.example.com/api/me   # 401 (server reached, no session)
```

Database migrations run automatically every time the server starts.

### 3. First sign-in

Open `https://<ROOT_DOMAIN>` and sign in with `DEFAULT_USER_EMAIL` (default `admin@<ROOT_DOMAIN>`) and `DEFAULT_USER_PASSWORD`. If you left the password blank, one was generated. Read it from the container's terminal in Dokploy (or `docker exec <container> …`):

```bash
cat /data/secrets/default_user_password
```

The account is created on the first boot only, so changing these variables later does not reset it. Then add your OpenRouter key under **Settings → Providers**.

Optional GitHub sign-in: create an OAuth App with callback `https://<ROOT_DOMAIN>/api/auth/github/callback`, set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, and list who may sign in with `GITHUB_ALLOWED_USERS` (logins) and/or `GITHUB_ALLOWED_ORGS` (organisations), then redeploy. With neither set, GitHub sign-in only admits accounts that already exist — every account gets a shell, so new sign-ups are closed by default.

### Generated secrets

On every start, [`init-secrets`](deploy/s6/scripts/init-secrets) makes sure `secret_key`, `postgres_password`, `dev_db_password` and `default_user_password` exist in `/data/secrets`. It only writes a file that is missing, so restarts keep the values the database was initialised with. A variable of the same name in the Environment tab takes precedence; use that only to carry over an existing install. **Without `secret_key`, stored API keys can't be decrypted**, so it is in every backup.

### Who can sign in

**Only give accounts to people you trust with the server itself.** The terminal, the agent's `bash` and the preview dev servers run in the container as its unprivileged `node` user. They cannot read the databases' files or `/data/secrets` (the server reads its secrets as root, then drops to `node`), but anyone who can open a terminal can read every other user's workspace and CLI credentials under `/data`. Keep `GITHUB_ALLOWED_USERS` / `GITHUB_ALLOWED_ORGS` tight. Isolating users from each other needs a separate UID or container per project, which isn't built yet.

### Development databases

Your projects (their terminals, dev servers and agents run inside the container) reach the databases on loopback. Use the `dev` user, never the harness's own `ucch` database. The `dev` user can't even connect to it.

| Engine | Host | Port | User | Password | Default DB |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | `127.0.0.1` | 5432 | `dev` | in each project's `.env` | `dev` |
| MySQL (with `ENABLE_MYSQL=true`) | `127.0.0.1` | 3306 | `dev` | same | `dev` |

The `dev` user may create as many databases as you like on both servers; add them in the UI under **Database → New connection**. Nothing is published outside the container; `psql` and `mysql` clients are installed for the terminal. To use database servers of your own instead, set `DEV_POSTGRES_URL` / `DEV_MYSQL_URL` (and `DATABASE_URL` for the harness itself); the embedded engines then stay off.

### Scaling

**One container, one replica.** Live terminals, project files, the event bus behind every WebSocket, the background workers and the database all live in it. Scale it vertically: give the VPS (or the application, under **Advanced → Resources**) more CPU and RAM. Agent turns are mostly waiting on model APIs, so one container handles many concurrent sessions. Tune the embedded PostgreSQL with `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE` and `PG_WORK_MEM`, or move it out with `DATABASE_URL`.

**Seeing where the time goes.** `/metrics` reports the server's own numbers in the Prometheus text format: event-loop delay, memory and GC, the engine queue, WebSocket connections, subscriptions and frames, HTTP latency by route, requests to the web app by kind (`document`, `rsc`, `rsc_prefetch`, `static`) with Next's latency, `/api/bootstrap` calls from server renders and from browsers, Postgres connections, and every 15 s the container's memory and CPU by service (`server`, `web`, `postgres`, `mysqld`) and by kind of process the server started (`claude`, `shell`, `git`, `other` for dev servers, …) beside the cgroup's own figures and OOM kills. Browsers add what people actually waited for, by page template (`web_vital_seconds`, `web_vital_cls`): LCP, INP, CLS and TTFB, a link click to the new page painted (`nav-skeleton`) and to its skeletons gone (`nav-content`), a streamed token to its paint (`frame-to-paint`) and a terminal key to its echo (`keystroke-to-echo`). Only those numbers are kept, never who sent them; the image's build argument `NEXT_PUBLIC_VITALS_SAMPLE_RATE` (0–1, default 1) is the share of page loads that report. `LOG_RESOURCE_SAMPLES=true` also logs each of those samples. Without `METRICS_TOKEN` it answers only from inside the container (`docker exec <container> curl -s localhost:3000/metrics`); with it, any caller presenting `Authorization: Bearer <token>`. The embedded PostgreSQL loads `pg_stat_statements` and logs every statement slower than `PG_LOG_MIN_DURATION_MS` (default `500`; `-1` turns the log off) to the container's log. `bash scripts/pg-top.sh` prints the top 20 statements by total time and by calls (`--reset` zeroes the counts first, so reset, do the thing, then read). With `DATABASE_URL` pointing at a server of your own, enable the same once by hand: start that server with `shared_preload_libraries=pg_stat_statements` (plus, optionally, `pg_stat_statements.track=top`, `track_io_timing=on` and `log_min_duration_statement=500`), restart it, then as a superuser, in the harness's database:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT pg_read_all_stats TO <the harness's role>;
```

and point the script at it with `PG_TOP_PSQL='psql <that DATABASE_URL>' bash scripts/pg-top.sh`.

### Research crawler (optional)

Run [Crawl4AI](https://github.com/unclecode/crawl4ai) as its own Dokploy service (image `unclecode/crawl4ai`) and set `CRAWL4AI_URL` (and `CRAWL4AI_API_TOKEN`). `BROWSER_USE_API_KEY` adds the escalation agent.

### Live previews (optional, one-time)

A project's running dev server is shown at `https://p{port}-{hash}.<ROOT_DOMAIN>`, served by the same container. That needs the `*.<ROOT_DOMAIN>` DNS record and a **wildcard certificate**, which Let's Encrypt only issues through a DNS challenge. Everything else works without this step.

With Cloudflare:

1. Cloudflare → **My Profile → API Tokens → Create Token → Edit zone DNS**, limited to your zone.
2. Dokploy → **Settings → Web Server → Traefik → Environment**: add `CF_DNS_API_TOKEN=<token>`.
3. Same place, **File System → `traefik.yml`**: next to the existing `letsencrypt` resolver add

   ```yaml
   certificatesResolvers:
     letsencrypt-dns:
       acme:
         email: you@example.com
         storage: /etc/dokploy/traefik/dynamic/acme-dns.json
         dnsChallenge:
           provider: cloudflare
   ```

4. Route the preview hosts to the application. If your Dokploy version accepts a wildcard domain, add `*.<ROOT_DOMAIN>` → port 3000 with the `letsencrypt-dns` resolver. Otherwise add a file under **File System → `dynamic/`**, e.g. `ucch-previews.yml`, with the application's service name from its **General** tab:

   ```yaml
   http:
     routers:
       ucch-previews:
         rule: HostRegexp(`^p[0-9]+-[a-z0-9]{12}\.ucch\.example\.com$`)
         entryPoints: [websecure]
         service: ucch-previews
         tls:
           certResolver: letsencrypt-dns
           domains:
             - main: ucch.example.com
               sans: ["*.ucch.example.com"]
     services:
       ucch-previews:
         loadBalancer:
           servers:
             - url: http://<application service name>:3000
   ```

5. **Restart Traefik**. After a minute: `curl -vI https://anything.ucch.example.com 2>&1 | grep -i issuer` shows Let's Encrypt.

Other DNS providers work the same way with their own [Traefik provider name](https://doc.traefik.io/traefik/https/acme/#providers) and token variable.

### Day-to-day

- **Update**: push to `main`, press **Deploy** (or enable Dokploy's auto-deploy webhook). The container gets `SIGTERM`; s6 stops the server first, with up to 60 s to finish and record in-flight work, then the UI and the databases.
- **Logs**: the application's **Logs** tab; every line is prefixed by its service.
- **Backups**: `docker exec <container> ucch-backup` writes a consistent `pg_dump` of the harness's database (and `dev`) plus `secret_key` to `/data/backups/<timestamp>/`, keeping the newest `BACKUP_KEEP` (7). Schedule it in Dokploy (**Schedules**) and copy `/data/backups` and `/data/workspaces` off the box. `/data/creds` holds per-user Claude/Codex CLI logins; don't copy it off the box. Restore with `ucch-restore /data/backups/<timestamp>`.
- **Security**: anyone who can sign in gets a shell inside the container (`AGENT_ALLOW_HOST_SHELL=true`). Only give accounts to people you trust. The Docker socket is deliberately not mounted.

### Migrating from the multi-container stack

The old multi-container Compose stack (separate `secrets`, `postgres`, `mysql`, `server` and `web` containers) moves over like this:

1. **Dump the old database**: `docker exec <old postgres> pg_dump -U ucch -Fc ucch > ucch.dump`.
2. **Carry `SECRET_KEY` over**: `docker exec <old server> cat /run/ucch-secrets/secret_key` and set it as `SECRET_KEY` in the new application's environment. **Without it, every stored API key and database connection is unreadable.**
3. Deploy the new application (above), then copy the dump in and restore it: `docker cp ucch.dump <container>:/data/ucch.dump && docker exec <container> ucch-restore /data/ucch.dump`.
4. Copy the old `workspaces` and `creds` volumes into `/data/workspaces` and `/data/creds` (`docker cp`, or a one-off container mounting both volumes); `init-dirs` gives them to `node` on the next start.
5. In your projects' `.env` files, the dev database host changes from `postgres` / `mysql` to `127.0.0.1`. Set `ENABLE_MYSQL=true` if any project uses MySQL, and dump and restore those databases the same way.
6. **Rollback**: nothing above touches the old volumes. Redeploy the old Compose service to go back.

### Try the production image locally

```bash
docker compose up -d --build                     # http://localhost:3000
docker compose exec ucch cat /data/secrets/default_user_password
bash scripts/smoke-container.sh                  # the end-to-end checks a deploy should pass
```

Stop with `docker compose down` (add `-v` to wipe all data).

---

## Current status

| Phase | Scope                                                     | State                    |
| ----- | --------------------------------------------------------- | ------------------------ |
| 1     | Protocol, database, event-sourced server, auth, web shell | **Done, verified** |
| 2     | Base image, Docker driver, terminals                      | Planned                  |
| 3     | Gateway, wildcard routing, cold start                     | Live preview proxy done; containers and cold start planned |
| 4     | Git clone/commit/push, editor, diff                       | Planned                  |
| 5     | Agent loop, tool registry, chat                           | Planned                  |
| 6     | Checkpoints, per-turn revert, fork                        | Planned                  |
| 7     | Live previews                                             | Planned                  |
| 8     | Context editing, compaction, quotas, cost                 | Planned                  |

**59 unit tests, four packages typechecking clean.** Coverage concentrates where it earns the most: the subdomain grammar against hostile input (16), the decision rules including authorization and path traversal (24), plus ticket semantics, secret encryption, and worker drain behavior.

### Layout

```
apps/server      Fastify + WebSocket + event log + orchestration
apps/web         Next.js UI (Tailwind v4 + shadcn/ui)
packages/protocol  Zod schemas: events, commands, RPC, hostname grammar
packages/db        Drizzle schema + migrations
packages/runtime   Docker driver, port discovery          (planned; empty)
packages/agent     Agent loop, tool registry              (Phase 5)
packages/vcs       git + checkpoint refs                  (planned; empty)
deploy/s6          the single container's services (s6-overlay)
images/base        The universal project runtime image    (Phase 2)
documentation/     Architecture and implementation plan
```

---

## Further reading

[`documentation/plan.md`](documentation/plan.md) — the single-container, performance and realtime plan; [`documentation/todo.md`](documentation/todo.md) — its task list, ticked off as it lands.
