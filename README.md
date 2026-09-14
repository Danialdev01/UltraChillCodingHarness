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

Node 22+, pnpm 10+, Docker. For the agent's document generation, `pandoc` and `typst` on PATH (the server image installs both; locally, `sudo pacman -S pandoc-cli typst`, `brew install pandoc typst`, or your distribution's equivalent).

### The whole thing, one line

Once `pnpm install` has run and `.env` exists, this starts Postgres and both services:

```bash
docker start ucch-pg-dev 2>/dev/null || docker run -d --name ucch-pg-dev -e POSTGRES_USER=ucch -e POSTGRES_PASSWORD=ucch -e POSTGRES_DB=ucch -p 55432:5432 postgres:16-alpine; pnpm dev
```

It reuses the `ucch-pg-dev` container if it already exists and creates it if it doesn't, then `pnpm dev` runs the API server (:3001) and the web UI (:3000) in parallel. Migrations apply on server boot. Open **http://localhost:3000**.

The first-time setup, and what each piece does, is below.

### Start it

```bash
pnpm install

# 1. A database
docker run -d --name ucch-pg-dev \
  -e POSTGRES_USER=ucch -e POSTGRES_PASSWORD=ucch -e POSTGRES_DB=ucch \
  -p 55432:5432 postgres:16-alpine

# 2. Configure
cp .env.development.example .env
```

The defaults in `.env.development.example` are set up for local work (`.env.example` is the production file for Dokploy). Point `DATABASE_URL` at the container above:

```
DATABASE_URL=postgres://ucch:ucch@localhost:55432/ucch
```

Then run the two services in separate terminals:

```bash
# Terminal 1 — API server on :3001 (migrations run automatically on boot)
pnpm --filter @ucch/server dev

# Terminal 2 — web UI on :3000
pnpm --filter @ucch/web dev
```

Open **http://localhost:3000**. You'll be redirected to the sign-in page.

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

### 1. Prepare the VPS

SSH in and create the shared resources the harness expects:

```bash
# Project working trees and per-account CLI logins live on the host, bind-
# mounted into the server, so they survive a redeploy. The server runs as
# root in its container today; when the container runtime lands, project
# containers run as uid 1000 and the ownership below already matches.
mkdir -p /srv/ucch/workspaces /srv/ucch/creds
chmod 700 /srv/ucch/creds
chown -R 1000:1000 /srv/ucch

# Only needed once the container runtime is enabled (not yet):
# docker network create ucch-projects
```

### 2. DNS

In Cloudflare, on `danialirfan.dev`:

| Type | Name         | Content     | Proxy              |
| ---- | ------------ | ----------- | ------------------ |
| A    | `ucch`     | your VPS IP | **DNS only** |
| A    | `api.ucch` | your VPS IP | **DNS only** |
| A    | `*.ucch`   | your VPS IP | **DNS only** |

**Grey cloud, not orange.** Cloudflare's proxy breaks WebSockets on arbitrary ports and adds a second TLS layer in front of Traefik's.

### 3. Wildcard certificate

The `*.ucch` record only pays off with a wildcard certificate, and **HTTP-01 cannot issue wildcards** — you need DNS-01. In Dokploy, add a second certificate resolver to Traefik's static configuration (Settings → Web Server → Traefik → File System → `traefik.yml`), keeping the existing HTTP-01 one for Dokploy's own domains:

```yaml
certificatesResolvers:
  letsencrypt-dns:
    acme:
      email: you@example.com
      storage: /etc/dokploy/traefik/dynamic/acme-dns.json
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
```

Then give the Traefik container a Cloudflare API token scoped to `Zone:DNS:Edit` on this zone, as `CF_DNS_API_TOKEN` (Settings → Web Server → Traefik → Environment Variables), and restart Traefik.

### 4. Create the applications (Dockerfile build type)

UCCH deploys as **two Dokploy Applications built from their Dockerfiles, plus a Dokploy Postgres database**, all in one project. [`deploy.md`](deploy.md) is the long form of these steps, with every field value and a troubleshooting table. Nixpacks is not an option: this is a pnpm monorepo that ships two services, needs a Debian base with `git`, `ripgrep`, `pandoc`, `php` and a glibc-linked native module (`node-pty`), and both Dockerfiles take build arguments. (A `docker-compose.yml` is also kept for a single-file deploy; the steps below are for the Application type.)

Check each image locally first if you like:

```bash
docker build -f apps/server/Dockerfile -t ucch-server .
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_WS_ORIGIN=https://api.ucch.danialirfan.dev --build-arg SERVER_ORIGIN=http://ucch-server:3001 -t ucch-web .
```

#### 4a. Database

**Create Service → Database → PostgreSQL.** Name it `ucch-db`, user `ucch`, database `ucch`, a long password. Deploy it, then copy the **Internal Connection URL** it shows (`postgres://ucch:...@<db-app-name>:5432/ucch`) — the server reaches it by that name on `dokploy-network`.

#### 4b. Server

**Create Service → Application**, name `ucch-server`, source = this repository, branch `main`.

| Tab | Field | Value |
| --- | --- | --- |
| Build Type | Build Type | **Dockerfile** |
| | Dockerfile Path | `apps/server/Dockerfile` |
| | Docker Context Path | `.` (repository root — the build copies `packages/*`) |
| | Docker Build Stage | *(leave empty)* |
| Environment | Environment Variables | see step 5 |
| Advanced → Mounts | Bind Mount | host `/srv/ucch/workspaces` → container `/srv/ucch/workspaces` |
| | Bind Mount | host `/srv/ucch/creds` → container `/srv/ucch/creds` |
| Domains | Host / Port / HTTPS / Certificate | `api.ucch.danialirfan.dev` / `3001` / on / Let's Encrypt |

Both mounts are what survives a redeploy: project working trees and the per-account CLI logins. **Do not mount `/var/run/docker.sock`** — nothing uses it until the container runtime lands, and leaving it out keeps a terminal inside the container from being root on the host.

Note the **App Name** Dokploy assigns on the General tab (something like `ucch-server-x1y2z3`). It is the container's DNS name and the next two steps need it.

#### 4c. Web

**Create Service → Application**, name `ucch-web`, same repository.

| Tab | Field | Value |
| --- | --- | --- |
| Build Type | Build Type | **Dockerfile** |
| | Dockerfile Path | `apps/web/Dockerfile` |
| | Docker Context Path | `.` |
| Environment | **Build Time Arguments** | `NEXT_PUBLIC_WS_ORIGIN=https://api.ucch.danialirfan.dev` |
| | | `SERVER_ORIGIN=http://<server App Name>:3001` |
| | Environment Variables | `NODE_ENV=production` |
| Domains | Host / Port / HTTPS / Certificate | `ucch.danialirfan.dev` / `3000` / on / Let's Encrypt |

Both values are **build arguments, not runtime variables**: the first is inlined into the browser bundle, the second into Next's rewrite table. Setting them only under Environment Variables has no effect, and a wrong `SERVER_ORIGIN` shows up as every `/api/*` call returning 500. Rebuild the web app whenever the server's App Name changes.

#### 4d. The preview wildcard

Dokploy's Domains tab writes `Host()` rules only, and the live preview needs `HostRegexp` for `p{port}-{hash}.ucch.danialirfan.dev`. Open **Web Server → Traefik → File System**, create `/etc/dokploy/traefik/dynamic/ucch-preview.yml`, and paste [`deploy/dokploy/ucch-preview.yml`](deploy/dokploy/ucch-preview.yml) with its two placeholders filled in (your root domain, and the server's App Name). Traefik loads it immediately; Dokploy leaves files it did not generate alone. This router is what actually requests the wildcard certificate, so it depends on the `letsencrypt-dns` resolver from step 3.

### 5. Environment

[`.env.example`](.env.example) is the server application's production environment, written for `ucch.danialirfan.dev`: paste the whole file into the **server** application's Environment tab and fill in the lines marked `>>> CUSTOMIZE` (database URL, `SECRET_KEY`, the default user's password, optionally GitHub OAuth). The essentials, for reference:

```env
NODE_ENV=production
PORT=3001
HOST=0.0.0.0
DATABASE_URL=<Internal Connection URL from step 4a>
ROOT_DOMAIN=ucch.danialirfan.dev
PUBLIC_SCHEME=https

# The terminal, the live preview's dev servers and the CLI providers all run
# inside this container until the container runtime lands. Production
# refuses them without this. See the Security note.
AGENT_ALLOW_HOST_SHELL=true

# GitHub OAuth App (optional if you set a default user):
#   Homepage URL  https://ucch.danialirfan.dev
#   Callback URL  https://ucch.danialirfan.dev/api/auth/github/callback
GITHUB_CLIENT_ID=<from GitHub>
GITHUB_CLIENT_SECRET=<from GitHub>

# Encrypts stored tokens at rest and signs preview cookies. openssl rand -hex 32
SECRET_KEY=<64 hex characters>

# Seeded on first boot, so there is a way in before GitHub OAuth is wired up.
# Only created if the email is unused. Use a real password here.
DEFAULT_USER_EMAIL=danialirfan@danialirfan.dev
DEFAULT_USER_PASSWORD=<a real password, not the local default>

WORKSPACE_ROOT=/srv/ucch/workspaces
CREDS_ROOT=/srv/ucch/creds
IDLE_STOP_MINUTES=30
```

`SECRET_KEY` must be exactly 64 hex characters — the server validates it at boot and refuses to start otherwise, rather than failing later when someone signs in. A variable left blank is treated as unset, so an empty `DEFAULT_USER_EMAIL` is fine. Leave `PUBLIC_PREVIEW_PORT` and `PUBLIC_WEB_ORIGIN` unset: behind Traefik the preview subdomains are on 443 and the web app is on the root domain, which are the defaults.

**Agent providers.** Besides the built-in OpenRouter loop, a project can run on the `claude` or `codex` CLI, billed to the person's own subscription (see `documentation/integration-spec-1.md`). Each account's CLI logins live under `CREDS_ROOT` (default `/srv/ucch/creds`, `0700`) — **exclude that path from backups** and never `docker cp` it. `AGENT_MAX_CONCURRENT_PER_USER` (default 2) caps how many CLI turns one account runs at once. Do **not** set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `CODEX_API_KEY` in the server's environment if you want subscription billing: the CLIs prefer a key over a login, and the server refuses to run a provider with one present. The CLIs themselves are not in the image yet; install them in the Dockerfile when you want those providers.

> **The OAuth callback goes to the root domain, not `api.`** — even though the server handles it. The web app proxies `/api/*` through to the server, so the callback completes on `ucch.danialirfan.dev` and the session cookie is set **first-party on the root domain**. Pointing the callback at `api.ucch.danialirfan.dev` would set the cookie on the wrong host and the browser would never send it. The server derives this URL from `ROOT_DOMAIN`, so it must match the OAuth App exactly.
>
> The WebSocket still connects directly to `api.` — it authenticates with a ticket rather than the cookie, which is precisely what tickets are for.

### 6. Deploy

Deploy the **server first** (its build is the slow one: apt, PHP and the dependency install, about five minutes cold), wait for its health check to go green — the image declares one against `/health`, and the server applies migrations on boot, so there is no separate migration step — then deploy the **web** app.

Verify:

```bash
curl https://api.ucch.danialirfan.dev/health
# {"status":"ok","version":"0.1.0","connections":0}

curl -o /dev/null -w '%{http_code}\n' https://ucch.danialirfan.dev/api/me
# 401 -- the rewrite reached the server. A 500 here means SERVER_ORIGIN was wrong at build time.

curl -o /dev/null -w '%{http_code}\n' -H 'Host: p8001-abcdefghijkl.ucch.danialirfan.dev' https://api.ucch.danialirfan.dev/
# 404 -- the preview proxy answered (unknown project); Traefik's own 404 would be plain text.

UCCH_BASE=https://api.ucch.danialirfan.dev node scripts/smoke-phase1.mjs
```

Then open `https://ucch.danialirfan.dev`, sign in, open a project, start a dev server in its terminal and press the globe in the top bar.

### 7. Verify the wildcard certificate

Before relying on project URLs, confirm the wildcard actually issued — this is the single most common thing to get wrong, and it fails silently until a project URL is opened:

```bash
curl -vI https://anything.ucch.danialirfan.dev 2>&1 | grep -i 'subject\|issuer'
```

A certificate covering `*.ucch.danialirfan.dev` means DNS-01 worked.

### What routes where today

| Host                         | Service                                    | Configured in |
| ---------------------------- | ------------------------------------------ | ------------- |
| `ucch.danialirfan.dev`     | `web`                                    | Dokploy Domains tab |
| `api.ucch.danialirfan.dev` | `server` (REST + WebSocket)              | Dokploy Domains tab |
| `p{port}-{hash}.ucch...`   | `server` (live preview proxy, HTTP + WS) | `deploy/dokploy/ucch-preview.yml` (or the compose labels) |

The preview router carries `tls.domains` for the wildcard, so it **needs the DNS-01 certificate from step 3** — an HTTP-01 resolver cannot issue `*.ucch.danialirfan.dev`. The `web` service is not involved: `/{hash}/preview` on the root domain is a Next rewrite to the server, which answers with a redirect to the subdomain.

When `pv-{hash}` previews land, they join the same regexp.

### Security note

With `AGENT_ALLOW_HOST_SHELL=true`, everyone who can sign in gets a shell **inside the server container** — that is where the terminal, the agents' `bash` and the live preview's dev servers run until the container runtime lands. UCCH is single-tenant and should only be exposed to people you trust with the box. The Dockerfile deployment deliberately does not mount `/var/run/docker.sock`; the compose file still does, for the runtime phase, and that socket is root-equivalent on the host.

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
