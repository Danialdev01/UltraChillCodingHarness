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

### Reverting is honest

Every agent turn is bracketed by a workspace snapshot stored as a hidden git ref (`refs/ucch/checkpoints/{thread}/{turn}`), captured through a temporary index so it never disturbs your HEAD, branch, staged changes, or stash. Reverting a turn rolls back **files and conversation together** — rolling back the chat while leaving modified files on disk is the specific failure this design exists to prevent.

### What the agent can and cannot do

The agent runs as a streaming loop against the Claude API with a plugin tool registry — `read_file`, `edit_file`, `glob`, `grep`, `bash`, `git_commit`, and so on. **Every tool executes inside the project container** via `docker exec`; the server never touches workspace files directly, so a rogue command is confined to the container.

There is deliberately **no `git_push` tool**. The agent can commit; only a person can push. Commits land on a `ucch/{thread}` branch, so `main` is never written to by accident.

---

## Running it locally

### Requirements

Node 22+, pnpm 10+, Docker.

### Start it

```bash
pnpm install

# 1. A database
docker run -d --name ucch-pg-dev \
  -e POSTGRES_USER=ucch -e POSTGRES_PASSWORD=ucch -e POSTGRES_DB=ucch \
  -p 55432:5432 postgres:16-alpine

# 2. Configure
cp .env.example .env
```

The defaults in `.env.example` are set up for local work. Point `DATABASE_URL` at the container above:

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

| | |
|---|---|
| **Email** | `danialirfan@danialirfan.dev` |
| **Password** | `danialdev` |

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
- **The live preview feature** (`pv-{hash}.ucch.danialirfan.dev`), where UCCH builds a project from a specific commit into a frozen container you can share. That's **Phase 7** and is not implemented yet. It is specified in [`documentation/plan.md` §6.6](documentation/plan.md), including the per-stack build recipes.

---

## Deploying on Dokploy

### 1. Prepare the VPS

SSH in and create the shared resources the harness expects:

```bash
# The network project containers and the gateway share.
docker network create ucch-projects

# Workspaces live on the host so the server and each project container
# see the same directory. uid 1000 matches the `coder` user in the image.
mkdir -p /srv/ucch/workspaces /srv/ucch/previews
chown -R 1000:1000 /srv/ucch
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

The `*.ucch` record only pays off with a wildcard certificate, and **HTTP-01 cannot issue wildcards** — you need DNS-01. In Dokploy, add a certificate resolver to Traefik's static configuration (Settings → Traefik):

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: you@example.com
      storage: /etc/dokploy/traefik/dynamic/acme.json
      dnsChallenge:
        provider: cloudflare
        resolvers:
          - "1.1.1.1:53"
```

Then give the Traefik container a Cloudflare API token scoped to `Zone:DNS:Edit` on this zone, as `CF_DNS_API_TOKEN`.

### 4. Create the application

In Dokploy: **Create Application → Docker Compose**, point it at this repository, and set the compose path to `docker-compose.yml`.

### 5. Environment

Set these in Dokploy's **Environment** tab:

```env
ROOT_DOMAIN=ucch.danialirfan.dev
POSTGRES_PASSWORD=<a long random string>

# GitHub OAuth App:
#   Homepage URL  https://ucch.danialirfan.dev
#   Callback URL  https://ucch.danialirfan.dev/api/auth/github/callback
GITHUB_CLIENT_ID=<from GitHub>
GITHUB_CLIENT_SECRET=<from GitHub>

# Encrypts stored GitHub tokens at rest. Generate with: openssl rand -hex 32
SECRET_KEY=<64 hex characters>

ANTHROPIC_API_KEY=<your key>
IDLE_STOP_MINUTES=30

# Seeded on first boot, so there is a way in before GitHub OAuth is wired up.
# Only created if the email is unused. Use a real password here.
DEFAULT_USER_EMAIL=danialirfan@danialirfan.dev
DEFAULT_USER_PASSWORD=<a real password, not the local default>
```

`SECRET_KEY` must be exactly 64 hex characters — the server validates it at boot and refuses to start otherwise, rather than failing later when someone signs in.

> **The OAuth callback goes to the root domain, not `api.`** — even though the server handles it. The web app proxies `/api/*` through to the server, so the callback completes on `ucch.danialirfan.dev` and the session cookie is set **first-party on the root domain**. Pointing the callback at `api.ucch.danialirfan.dev` would set the cookie on the wrong host and the browser would never send it. The server derives this URL from `ROOT_DOMAIN`, so it must match the OAuth App exactly.
>
> The WebSocket still connects directly to `api.` — it authenticates with a ticket rather than the cookie, which is precisely what tickets are for.

### 6. Deploy

Hit **Deploy**. The compose file brings up Postgres, the API server, and the web UI; the server applies migrations on boot, so there is no separate migration step.

Verify:

```bash
curl https://api.ucch.danialirfan.dev/health
# {"status":"ok","version":"0.1.0","connections":0}

UCCH_BASE=https://api.ucch.danialirfan.dev node scripts/smoke-phase1.mjs
```

Then open `https://ucch.danialirfan.dev` and sign in with GitHub.

### 7. Verify the wildcard certificate

Before relying on project URLs, confirm the wildcard actually issued — this is the single most common thing to get wrong, and it fails silently until a project URL is opened:

```bash
curl -vI https://anything.ucch.danialirfan.dev 2>&1 | grep -i 'subject\|issuer'
```

A certificate covering `*.ucch.danialirfan.dev` means DNS-01 worked.

### What routes where today

Phase 1 routes two hostnames directly, because the gateway service arrives in Phase 3:

| Host                         | Service                       |
| ---------------------------- | ----------------------------- |
| `ucch.danialirfan.dev`     | `web`                       |
| `api.ucch.danialirfan.dev` | `server` (REST + WebSocket) |

When the gateway lands, a single `HostRegexp` router replaces both and dispatches `p{port}-{hash}` and `pv-{hash}` subdomains in code. That is one label change in `docker-compose.yml` plus the new service — the labels are already written out in [`documentation/plan.md` §9](documentation/plan.md).

### Security note

`server` mounts `/var/run/docker.sock`, which is **root-equivalent on the host**. That is how it creates project containers, and it is why UCCH is single-tenant and should only be exposed to people you trust with the box. The Docker access is isolated behind a narrow interface in `packages/runtime`, so moving to a rootless socket proxy later touches one file.

---

## Current status

| Phase | Scope                                                     | State                    |
| ----- | --------------------------------------------------------- | ------------------------ |
| 1     | Protocol, database, event-sourced server, auth, web shell | **Done, verified** |
| 2     | Base image, Docker driver, terminals                      | Planned                  |
| 3     | Gateway, wildcard routing, cold start                     | Planned                  |
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
