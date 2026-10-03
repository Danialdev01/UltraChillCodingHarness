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

UCCH deploys as **one Docker Compose service**. A single deploy builds the images and starts everything in [`docker-compose.yml`](docker-compose.yml):

| Container | What it is | Replicas |
| --- | --- | --- |
| `secrets` | one-shot: generates every password and key on the first deploy, keeps them in the `secrets` volume | runs, then exits |
| `postgres` | the harness's own data (database `ucch`) + a `dev` user for your projects | 1 |
| `mysql` | development databases for your projects | 1 |
| `server` | API, WebSocket, terminals, agent workers ([`Dockerfile`](Dockerfile) target `server`) | **1** |
| `web` | Next.js UI ([`Dockerfile`](Dockerfile) target `web`) | `WEB_REPLICAS` (default 2) |
| `crawl4ai` | research crawler, only with `COMPOSE_PROFILES=research` | 1 |

You don't generate passwords, copy service names between tabs or write Traefik config. Routing comes from labels in the compose file.

### 1. Before you start

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`), ports 80 and 443 open. 2 vCPU / 4 GB RAM is comfortable (the first build compiles Next.js); add ~1 GB for the research crawler.
- A domain for UCCH, e.g. `ucch.example.com`, with a DNS **A record** pointing at the VPS. For live previews also add `*.ucch.example.com` (see [Live previews](#live-previews-optional-one-time)). On Cloudflare, set both to **DNS only** (grey cloud).
- This repository on GitHub (or any Git URL Dokploy can reach).

### 2. Deploy

1. **Projects → Create Project** → `ucch`.
2. Inside it: **Create Service → Compose**. **Provider**: this repository, branch `main`. **Compose Type**: Docker Compose. **Compose Path**: `./docker-compose.yml`.
3. **Environment** tab: paste [`.env.example`](.env.example) and set **`ROOT_DOMAIN`**. That is the only required value. Setting `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD` for your first login is recommended.
4. **Deploy**. The first build takes ~5 minutes; later ones reuse the cache. Leave the **Domains** tab empty. The compose labels already route `ROOT_DOMAIN` and request its Let's Encrypt certificate.

Check it:

```bash
curl -o /dev/null -w '%{http_code}\n' https://ucch.example.com/login    # 200 (web)
curl -o /dev/null -w '%{http_code}\n' https://ucch.example.com/api/me   # 401 (server reached, no session)
```

Database migrations run automatically every time the server starts.

### 3. First sign-in

Open `https://<ROOT_DOMAIN>` and sign in with `DEFAULT_USER_EMAIL` (default `admin@<ROOT_DOMAIN>`) and `DEFAULT_USER_PASSWORD`. If you left the password blank, one was generated. Read it from the server container's terminal in Dokploy (or `docker exec <server container> …`):

```bash
cat /run/ucch-secrets/default_user_password
```

The account is created on the first boot only, so changing these variables later does not reset it. Then add your OpenRouter key under **Settings → Providers**.

Optional GitHub sign-in: create an OAuth App with callback `https://<ROOT_DOMAIN>/api/auth/github/callback`, set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, redeploy.

### Generated secrets

[`deploy/secrets.sh`](deploy/secrets.sh) writes `secret_key`, `postgres_password`, `mysql_root_password`, `dev_db_password`, `default_user_password` and `crawl4ai_api_token` into the `secrets` volume. It only writes a file that is missing, so redeploys keep the values the databases were initialised with. A variable of the same name in the Environment tab takes precedence. Use that only to carry over an existing install's passwords. **Back up the `secrets` volume together with `postgres-data`**: without `secret_key`, stored API keys can't be decrypted.

### Development databases

Your projects (their terminals, dev servers and agents run inside `server`) reach the databases by container name. Use the `dev` user, never the harness's own `ucch` database. The `dev` user can't even connect to it.

| Engine | Host | Port | User | Password | Default DB |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | `postgres` | 5432 | `dev` | `cat /run/ucch-secrets/dev_db_password` | `dev` |
| MySQL | `mysql` | 3306 | `dev` | same | `dev` |

The `dev` user may create as many databases as you like on both servers; add them in the UI under **Database → New connection**. Neither database is published on a host port; `psql` and `mysql` clients are installed in the server's terminal.

### Scaling

- **Web UI**: stateless. Set `WEB_REPLICAS` (e.g. `4`) and redeploy. Traefik load-balances across every replica and health-checks each one on `/login`.
- **Server**: always **one replica**. Live terminals, project working trees on its volume, the event bus to WebSocket clients and the background workers all live in that one process, so a second copy would split them. Scale it vertically: give the VPS (or the container, under **Advanced → Resources**) more CPU and RAM. Agent turns are mostly waiting on model APIs, so one server handles many concurrent sessions.
- **Databases**: PostgreSQL holds only the harness's event log and read models and stays small. For heavy dev-database use, give `mysql`/`postgres` more memory, or point `DATABASE_URL` at a managed PostgreSQL.

### Research crawler (optional)

Set `COMPOSE_PROFILES=research` in the Environment tab and redeploy. The `crawl4ai` container starts and the server connects to it automatically with a generated token. `BROWSER_USE_API_KEY` adds the escalation agent. To use a Crawl4AI server running elsewhere, set `CRAWL4AI_URL` (and `CRAWL4AI_API_TOKEN`) instead.

### Live previews (optional, one-time)

A project's running dev server is shown at `https://p{port}-{hash}.<ROOT_DOMAIN>`. That needs the `*.<ROOT_DOMAIN>` DNS record and a **wildcard certificate**, which Let's Encrypt only issues through a DNS challenge. Everything else works without this step.

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

4. **Restart Traefik**. After a minute: `curl -vI https://anything.ucch.example.com 2>&1 | grep -i issuer` shows Let's Encrypt.

Other DNS providers work the same way with their own [Traefik provider name](https://doc.traefik.io/traefik/https/acme/#providers) and token variable.

### Day-to-day

- **Update**: push to `main`, press **Deploy** (or enable Dokploy's auto-deploy webhook). The server gets `SIGTERM` and up to 60 s to finish and record in-flight work; `restart: unless-stopped` brings every container back after a crash or reboot.
- **Logs**: the service's **Logs** tab, per container.
- **Backups** (Docker volumes): `postgres-data` + `secrets` (the harness) and `workspaces` (your project files) matter; `mysql-data` holds dev data. `creds` holds per-user Claude/Codex CLI logins. Don't copy it off the box.
- **Security**: anyone who can sign in gets a shell inside `server` (`AGENT_ALLOW_HOST_SHELL=true`). Only give accounts to people you trust. The Docker socket is deliberately not mounted.

### Try the production stack locally

```bash
docker network create dokploy-network            # once; Dokploy creates it on the VPS
echo ROOT_DOMAIN=ucch.localhost > .env.deploy
docker compose --env-file .env.deploy up -d --build
docker compose ps                                # secrets exited 0; the rest healthy
docker compose exec server cat /run/ucch-secrets/default_user_password
```

Nothing is published on a host port; Traefik on the `dokploy-network` is the way in. Stop with `docker compose down` (add `-v` to wipe all data).

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
apps/gateway     Subdomain proxy                          (Phase 3)
packages/protocol  Zod schemas: events, commands, RPC, hostname grammar
packages/db        Drizzle schema + migrations
packages/runtime   Docker driver, port discovery          (Phase 2)
packages/agent     Agent loop, tool registry              (Phase 5)
packages/vcs       git + checkpoint refs                  (Phase 4/6)
images/base        The universal project runtime image    (Phase 2)
documentation/     Architecture and implementation plan
```

---

## Further reading

[`documentation/plan.md`](documentation/plan.md) — the full architecture reference: design influences ([T3 Code](https://github.com/pingdotgg/t3code) for the runtime shape, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the agent shape), subsystem specifications, per-phase deliverables with acceptance checks, the end-to-end acceptance test, and risks.
