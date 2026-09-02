# UCCH — Ultra Chill Coding Harness

**Implementation plan and architecture reference**

Status: Phase 1 delivered and verified · Last updated 2026-09-02

---

## 1. Context

UCCH is a cloud coding harness served from `https://ucch.danialirfan.dev` and deployed on a Dokploy VPS. It supports one workflow, end to end:

1. **Clone** a GitHub repository into an isolated container
2. **Run** commands in it, with dev-server ports exposed over public HTTPS
3. **Prompt** an AI agent to change the code, watching the diff stream in
4. **Commit** and push the result to git
5. **Publish** a frozen live preview at a shareable URL

Target stacks: **HTML, PHP, Laravel, React (Vite), Next.js**. Single-tenant (trusted users). Everything container-based.

The problem this solves is that the three things a coding agent needs — a real filesystem, a real process to run the dev server, and a URL a human can look at — are exactly the three things a chat interface does not have. UCCH puts all three on the server and streams the result.

---

## 2. Design influences

Two open-source harnesses solve complementary halves of this problem. UCCH takes the runtime shape from one and the agent shape from the other.

### 2.1 T3 Code — the runtime shape

[pingdotgg/t3code](https://github.com/pingdotgg/t3code) is an agent harness control surface: a server runtime owning sessions, workspaces, and version control, with web/desktop/mobile clients over one authenticated RPC WebSocket.

What UCCH takes:

| Idea | Why it applies here |
|---|---|
| **The server is the execution boundary.** Every provider process, terminal, git operation, and filesystem read happens server-side; clients render events and diffs only. | For a cloud harness this is not an adaptation — it is the native model. There is no client-side alternative. |
| **Event sourcing.** Clients dispatch typed commands; a pure decision function emits events; one transaction appends events, updates the read model, and publishes to subscribers. | The read model can never durably disagree with the log, and the decision rules become a pure function that is exhaustively testable. |
| **Reactors.** Side effects drain through named workers with observable outstanding-item counts. | Tests await real completion instead of sleeping. |
| **Checkpoints as hidden git refs.** Each turn is bracketed by a snapshot stored as a git ref, not file copies in the database. | Exact per-turn diffs and reverts at near-zero storage cost. |
| **One authenticated WebSocket with method-level authorization.** Holding a valid socket is not authorization to call everything on it. | A single scope check at connect time would be the wrong boundary. |

### 2.2 DeepSeek Harness — the agent shape

[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) is a plugin-first agent framework built on the Cordis kernel.

What UCCH takes:

| Idea | Why it applies here |
|---|---|
| **Everything is a plugin.** Model adapter, tool registry, session log, and the agent loop are all replaceable through configuration. | Tool sets differ per stack and per trust level; a registry beats a hardcoded list. |
| **Append-only session log.** Everything the model sees is recorded — system prompts, reasoning, tool calls and results, and every context injection. | Resume, fork, and replay all fall out of the schema for free rather than needing separate machinery. |
| **Runtime modes** (standard / minimal / code) as presets over one registry. | Becomes `standard` / `minimal` / `readonly` tool presets. |

### 2.3 What neither provides

Both run locally against a developer's own machine. Neither has a **public HTTPS gateway that exposes containerized dev servers and shareable frozen previews**. That is the piece UCCH adds, and it drives the routing design in §4.

---

## 3. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Port & preview routing | **Wildcard subdomain** | See below |
| Agent core | **Own streaming loop + plugin tool registry** | Full control of context, cost, permissions, and the event log |
| Tenancy | **Single-tenant, trusted users** | Seams kept for multi-tenant later; see §6.2 |
| Persistence | **Postgres + host bind mounts** | Log in Postgres, workspaces as plain directories |

### 3.1 Why subdomains, not path prefixes

The original specification used `/{project_hash}/port:{n}/{url}`. That breaks the target stacks:

- Laravel emits `/build/app.css`, Vite emits `/@vite/client`, Next.js emits `/_next/static/...` — all absolute, all missing the prefix
- HMR WebSocket URLs are constructed from `location.origin` and would point at the wrong path
- SPA routers rewrite the address bar and destroy the prefix on the first client-side navigation

Fixing this needs an HTML/CSS/JS rewriting proxy plus per-framework base-path environment hacks, and still leaks. Subdomains eliminate the entire class of problem: no rewriting, no base-path configuration, and cookies isolated per project as a bonus. The cost is a wildcard DNS record and a DNS-01 wildcard certificate — both one-time setup.

**The path form is kept as a 302 alias** so the originally specified links remain valid entry points.

---

## 4. Architecture

### 4.1 Topology

```
                    Cloudflare DNS  *.ucch.danialirfan.dev
                              │
                    ┌─────────▼─────────┐
                    │ Traefik (Dokploy) │  wildcard TLS via DNS-01
                    └─────────┬─────────┘
                              │  ONE HostRegexp router → gateway
                    ┌─────────▼─────────┐
                    │     gateway       │  subdomain → container:port
                    └────┬─────────┬────┘
                         │         │
       ┌─────────────────▼──┐   ┌──▼──────────────────────────┐
       │  web (Next.js UI)  │   │  project containers (N)     │
       └─────────┬──────────┘   │    ucch-proj-{hash}         │
                 │ WSS /ws      │    ucch-preview-{hash}      │
       ┌─────────▼──────────┐   └──▲──────────────────────────┘
       │  server (Fastify)  │──────┘ docker exec / attach
       │   event log        │
       │   agent loop       │   ┌──────────────┐
       │   orchestrator     │──▶│  Postgres    │
       └────────────────────┘   └──────────────┘
                 │
       /srv/ucch/workspaces/{projectId}   ← bind-mounted into containers
```

Four long-lived services plus N project containers. **`server` is the only process holding the Docker socket and the Anthropic API key.**

### 4.2 Repository layout

```
ucch/
├── apps/
│   ├── server/          Fastify + ws + Docker orchestration + agent runtime
│   ├── web/             Next.js UI (editor, chat, terminal, diff, previews)
│   └── gateway/         Subdomain-routing HTTP/WS reverse proxy
├── packages/
│   ├── protocol/        Zod schemas: events, commands, RPC, hostname grammar
│   ├── db/              Drizzle schema + migrations
│   ├── agent/           Agent loop, tool registry, session log
│   ├── runtime/         Docker driver, port discovery, exec streams
│   └── vcs/             git clone/commit/push + checkpoint refs
├── images/
│   ├── base/            The universal project runtime image
│   └── preview/         Frozen preview runtime
├── scripts/             Smoke tests
├── documentation/       This document
└── docker-compose.yml   Dokploy deployment target
```

pnpm workspaces · TypeScript strict (`noUncheckedIndexedAccess` on) · ESM · Node 22+.

### 4.3 The hostname grammar

Parsed left of the root domain. Implemented as a pure function in `packages/protocol/src/hostname.ts`.

| Pattern | Target |
|---|---|
| *(bare)* / `www` | `web:3000` |
| `api` | `server:3001` |
| `p{port}-{projectHash}` | `ucch-proj-{hash}:{port}` |
| `pv-{previewHash}` | `ucch-preview-{hash}:{port}` |

Hashes are 12 characters from `[a-z0-9]` — no hyphens, because `-` is the field separator in the label itself.

This function runs **before any authentication**, on attacker-controlled input, so it is written defensively and tested as such:

- Nested labels rejected (`evil.p3000-{hash}.root` must not resolve into the container)
- Suffix-similar domains rejected (`p3000-{hash}.evilucch.danialirfan.dev` — `endsWith` alone would accept it)
- Ports below 1024 rejected (never bound by an unprivileged dev server)
- Hash length exact, not minimum
- Case-insensitive and port-suffix tolerant, because hostnames legitimately are

---

## 5. Core concepts

### 5.1 The event log

`events` is the single source of truth for **project activity**. Identity and organisation — `users`, `sessions`, `workspaces` — are plain state and are not event-sourced, which is why every event carries a project. Replaying the log rebuilds what happened inside projects, not who exists. Every other table is a projection that can be rebuilt by replay.

**The hierarchy is user → workspaces → projects → sub-agents.** A workspace is the company/team container. Ownership is a single `owner_user_id`; multi-member workspaces need only a `workspace_members` join table, because authorization already resolves *through* the workspace rather than through the project. `projects.user_id` is a denormalised copy used by background scans and is never read for authorization, so the two cannot disagree in a way that grants access.

```
workspaces   id, slug, name, owner_user_id     UNIQUE (owner_user_id, slug)
projects     id, hash, workspace_id, user_id, name, repo_url, ...
subagents    id, project_id, name, model, tool_preset, system_prompt
                                              UNIQUE (project_id, name)
```

```
Command  →  decide(state, command, ctx) → Event[]    (pure)
         →  ONE transaction: project() then append events
         →  commit
         →  publish to subscribers
         →  reactors drain side effects → new Events
```

Three properties this buys:

1. **`decide()` is pure.** No database, no Docker, no clock, no randomness — every non-deterministic input arrives via `DecisionContext`. Every invariant about what the system will and will not do lives in one testable function.
2. **Intent is distinguishable from outcome.** A decision emits `container.state_changed: creating`; the reactor emits what actually resulted. The log records both.
3. **Publication follows commit.** Subscribers never observe an event a later crash could roll back.

**Ordering note:** inside the append transaction, the projection runs *before* the event insert, because `events.project_id` is a foreign key and a `project.created` event cannot reference a row that does not exist yet. Both statements share one transaction, so the internal ordering is invisible to readers — atomicity is what callers depend on.

**Transient events.** `terminal.output`, `agent.thinking_delta`, and `agent.text_delta` are published to subscribers but not persisted. They would dominate the log and are reconstructible from the completed turn.

### 5.2 Checkpoints

Each agent turn is bracketed by a workspace snapshot stored as a hidden git ref:

```
refs/ucch/checkpoints/{threadId}/{turnSeq}
```

Captured through a temporary index so it never disturbs HEAD, the current branch, staged changes, or the stash:

```bash
GIT_INDEX_FILE=/tmp/ucch-idx git add -A
tree=$(git write-tree)
commit=$(git commit-tree $tree -p $(git rev-parse HEAD) -m "ucch checkpoint")
git update-ref refs/ucch/checkpoints/{thread}/{turn} $commit
```

This gives exact per-turn diffs (`git diff <before> <after>`), cheap reverts, and — critically — **honest reverts**: reverting a turn reverts files *and* thread state together. Rolling back the chat while leaving modified files on disk is the specific inconsistency this design exists to prevent.

### 5.3 The tool registry

```ts
interface Tool<I> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;      // → JSON Schema, strict: true
  permission: "read" | "write" | "exec";
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}
```

**Every tool executes inside the project container via `docker exec`.** The server never touches workspace files directly. A rogue command is confined to the container, and the tool surface is identical regardless of where the loop runs.

Plugins register tool sets; presets select them.

| Plugin | Tools |
|---|---|
| `fs` | `read_file`, `write_file`, `edit_file` (str-replace), `list_dir` |
| `search` | `glob`, `grep` (ripgrep) |
| `shell` | `bash` (streams into the terminal pane as it runs) |
| `git` | `git_status`, `git_diff`, `git_log`, `git_commit` |
| `project` | `restart_dev_server`, `list_ports`, `read_logs` |

Note there is **no `git_push` tool**. Pushing is outward-facing and hard to reverse: the agent can commit, only a person can push.

---

## 6. Subsystem specifications

### 6.1 Gateway (`apps/gateway`)

A small Fastify + `http-proxy` service. Traefik hands it *all* wildcard traffic through one router; the gateway does per-request dispatch in code.

This is deliberately one dynamic router rather than programmatically writing Traefik configuration per container — far less moving machinery, and it allows cold-start handling and friendly error pages.

Requirements:

- Resolve hash → project through a short-TTL cache over the server API, invalidated by an event subscription
- **Upgrade WebSockets** — non-negotiable; HMR dies without it
- **Cold start**: if the container is stopped, ask the server to start it and hold the request behind a polling "waking up" page
- Set `X-Forwarded-Proto: https` and `X-Forwarded-Host` so Laravel generates correct absolute URLs
- Stream responses without buffering, so SSE and long-polling work
- Friendly 502 when nothing is listening on the requested port yet
- Serve the path alias: `GET /{hash}/port:{n}/*` → 302 to the subdomain

### 6.2 Container runtime (`packages/runtime`)

**Base image** (`images/base/Dockerfile`) — one image covering every target stack. Cold start is then a container create against a warm local image (~300ms), not a build.

- Debian bookworm-slim
- PHP 8.3 CLI + FPM, `composer`, and the extensions Laravel needs (`pdo_mysql`, `pdo_pgsql`, `mbstring`, `xml`, `curl`, `zip`, `gd`, `bcmath`, `intl`)
- Node 22 + corepack (pnpm, yarn, npm)
- `git`, `rg` (ripgrep — the `grep` tool depends on it), `curl`, `unzip`, `sqlite3`
- Non-root user `coder` (uid 1000, matching the host bind-mount owner)
- No entrypoint app: the container idles on `sleep infinity`; all work arrives via `docker exec`

**Lifecycle** — `dockerode` against the mounted socket.

| Operation | Behavior |
|---|---|
| `ensureContainer(projectId)` | Create-if-absent, start-if-stopped. Named `ucch-proj-{hash}`. |
| `exec(projectId, argv, opts)` | Streaming duplex for terminals, or buffered stdout/stderr/exit for tools |
| `stop` / `remove` | Removal deletes the container; the workspace bind mount survives |

Configuration:

- **Mount** `/srv/ucch/workspaces/{projectId}` → `/workspace` (rw)
- **Network** `ucch-projects` (user-defined bridge). The gateway is attached too, so it resolves containers by name — **no published host ports, ever**
- **Limits** 2 CPU, 2 GB memory, `pids-limit 512`. Set from day one despite single-tenancy: a runaway `next build` should not take down the VPS
- **Idle reaper** stops containers with no exec activity and no listening ports for 30 minutes. State is on disk, so restart is transparent

**Port discovery** — nothing tells us when `php artisan serve` opens port 8000, so poll for it. Every 2s while a project has a running process, read `/proc/net/tcp` and `/proc/net/tcp6` inside the container, parse listening sockets (state `0A`), diff against the last snapshot, emit `port.opened` / `port.closed`.

> **The 127.0.0.1 trap.** Laravel's `artisan serve` and Vite bind loopback by default, which is unreachable from the gateway container. Three mitigations, all needed: inject `HOST=0.0.0.0`; ship canned commands with explicit flags (`php artisan serve --host=0.0.0.0`, `vite --host 0.0.0.0`); and mark loopback-only listeners in the ports panel with a one-click rebind, since the port is detected but the link would be dead.

### 6.3 Server (`apps/server`)

Event-sourced core per §5.1, with commands serialized through a single worker fiber. This trades write throughput for the guarantee that no decision ever runs on stale state — for a personal harness, unambiguously the right way round.

**Reactors**, each a `DrainableWorker`:

| Reactor | Responsibility |
|---|---|
| `ContainerReactor` | Create/start/stop/remove containers; clone repositories |
| `PortWatchReactor` | Poll for listening ports, emit port events |
| `AgentTurnReactor` | Run the agent loop for a queued turn |
| `CheckpointReactor` | Capture, diff, and revert checkpoints |
| `PreviewReactor` | Build and publish frozen previews |

**Authorization.** GitHub OAuth → session cookie → a short-lived single-use WebSocket ticket redeemed at upgrade. Sessions are stored hashed, so a database leak does not hand over live sessions. Tickets are in-memory and ephemeral by nature.

> Why tickets: a browser cannot set an `Authorization` header on a WebSocket handshake, and a long-lived token in the query string leaks into proxy logs and `Referer` headers. A ticket that is worthless once spent is the right shape.

`REQUIRED_SCOPE` maps every command to the scope needed to dispatch it. A command missing from the map is **rejected**, not allowed — adding a command without deciding its authorization is a bug, not a default.

**Multi-tenancy seams** kept from day one, so hardening later is additive rather than a rewrite: `user_id` on every project row, per-project network and resource quotas, and `not_found` (never `forbidden`) for another user's project — whether a project exists is itself privileged information.

### 6.4 Agent (`packages/agent`)

A **manual streaming loop** against `client.messages.stream()`.

The SDK's `beta.messages.toolRunner` would work, but every stream event must land in the append-only log with a monotonic sequence number, turns are bracketed by checkpoints, and cancellation must interrupt between tool calls. Owning the loop is clearer than threading all of that through runner hooks, and keeps a beta dependency out of the hot path.

```ts
model: "claude-opus-5"
max_tokens: 64000
thinking: { type: "adaptive", display: "summarized" }  // reasoning shown in the UI
output_config: { effort: "xhigh" }                     // best setting for coding work
```

Per iteration: stream deltas → append to the log and push over the WebSocket → on `stop_reason === "tool_use"`, execute all tool-use blocks **in parallel** and return every `tool_result` in a **single** user message → repeat.

Non-obvious rules that are easy to get wrong:

- **Splitting tool results across multiple user messages silently trains Claude out of parallel calls.** One message, always.
- A failed tool returns `tool_result` with `is_error: true` — never a dropped result.
- `stop_reason === "pause_turn"` pushes the assistant turn back and continues.
- **Thinking blocks must be echoed back unchanged.** They carry signatures; text deltas cannot reconstruct them. This is why `agent.message` stores raw content blocks verbatim — see §7.2.

**Context management**, in escalation order:

1. **Prompt caching** — 4 breakpoints ordered `tools` → `system` → project context → conversation prefix. The tool list must be deterministically ordered and the system prompt must contain no timestamps, or every request silently misses cache.
2. **Context editing** — `clear_tool_uses_20250919` (beta `context-management-2025-06-27`). A coding agent's context is mostly file reads that went stale three edits ago.
3. **Compaction** — beta `compact-2026-01-12` for very long threads. Append the whole `response.content` back into messages, not just extracted text, or the compaction state is silently lost.

**System prompt** is assembled stable → volatile so caching holds: fixed harness rules, then detected stack, then `AGENTS.md`/`CLAUDE.md` if present, then a shallow file tree.

### 6.5 Git (`packages/vcs`)

- **Clone** — GitHub OAuth (`repo` scope). Token encrypted at rest (AES-256-GCM), injected per-command via `GIT_ASKPASS`, never written to `.git/config` or the workspace
- **Commit** — UI button (with "draft message from diff") and the `git_commit` tool
- **Push** — explicit user action only, `admin` scope, no agent tool
- **Branch** — `ucch/{thread-slug}` created on a thread's first commit, so `main` is never written to by accident

### 6.6 Previews

A preview is a **frozen container built from a specific commit** — not a proxy onto the live dev server, which would change under the viewer's feet.

`PreviewReactor.publish(projectId, commitSha)`:

1. `git worktree add` the commit into `/srv/ucch/previews/{hash}`
2. Detect the stack, run the matching build + serve recipe
3. Start `ucch-preview-{hash}` on `ucch-projects`
4. Insert into `previews`; the gateway serves it at `pv-{hash}.{root}`
5. Default 7-day TTL; the reaper removes container and worktree together

| Stack | Build | Serve |
|---|---|---|
| Static HTML | — | nginx on 80 |
| PHP / Laravel | `composer install --no-dev`, `npm ci && npm run build`, `artisan migrate --force` on a per-preview SQLite file | `php artisan serve --host=0.0.0.0` |
| React (Vite) | `npm ci && npm run build` | nginx on `dist/` with SPA fallback |
| Next.js | `npm ci && npm run build` | `npm start --hostname 0.0.0.0` |

Previews are unlisted-by-hash and public — that is the point of a shareable link. Per-preview passwords are a follow-up, not v1.

### 6.7 Web UI (`apps/web`)

Next.js, `@xterm/xterm` for terminals, CodeMirror 6 for editing, `shiki` for diffs.

Four panes: **file tree · editor/diff · agent chat · terminal + ports**.

- **Chat** streams thinking, text, and tool calls live; each tool call is an expandable row with input and result. A per-turn diff sits under each assistant message with a **Revert** button wired to the checkpoint.
- **Ports panel** lists live listeners with public URLs, an inline iframe, and the loopback rebind hint.
- **Terminal** attaches to `docker exec -it` over the WebSocket, with a stack-aware command palette.
- **Source control** — changed files, staged diff, commit box, push button.
- **Previews** — publish from a commit, list live previews with links and expiry.

The client holds **no independent model of the world** — only what the server has told it. Reconnection resubscribes from the last sequence number seen, so a dropped connection replays the gap rather than losing it.

---

## 7. Status

### 7.1 Phase 1 — delivered and verified

| Package | Files |
|---|---|
| `packages/protocol` | `events.ts` · `commands.ts` · `rpc.ts` · `hostname.ts` · `ids.ts` |
| `packages/db` | `schema.ts` · `index.ts` · `migrate.ts` · `migrations/0000_*.sql` |
| `apps/server` | `config.ts` · `decide.ts` · `engine.ts` · `eventstore.ts` · `bus.ts` · `worker.ts` · `auth.ts` · `crypto.ts` · `ws.ts` · `index.ts` |
| `apps/web` | `src/lib/client.ts` · `src/app/page.tsx` · `layout.tsx` · `globals.css` |
| `scripts` | `smoke-phase1.mjs` |

**Test coverage: 59 unit tests, all four packages typecheck clean.**

| Suite | Tests | Covers |
|---|---|---|
| `hostname.test.ts` | 16 | Subdomain grammar including hostile input |
| `decide.test.ts` | 24 | Decision rules, authorization, path traversal |
| `auth.test.ts` | 7 | Ticket single-use/forgery, config guards |
| `crypto.test.ts` | 6 | AES-256-GCM round-trip, tamper detection |
| `worker.test.ts` | 6 | Drain semantics, serialization, error isolation |

**Verified end to end** against a live server on Postgres via `scripts/smoke-phase1.mjs`: health → authenticate → issue ticket → WebSocket connect → `ready` frame → heartbeat → malformed-frame rejection → `project.create` → `not_found` on an unknown project → subscribe → live push. The event log and the projection agree in the database.

### 7.2 Findings from Phase 1

Three things worth recording, because two were real bugs and one is a design constraint that was nearly missed.

**Dispatches hung forever.** A throwing handler in the orchestration worker never settled the caller's promise — surfacing as a silent client hang with nothing logged. Fixed: every path settles the promise, and the worker's error channel is wired to the logger. *A queue that swallows handler exceptions is worse than one that crashes.*

**Foreign-key violation on the very first command.** `EventStore.append` inserted the event row before the projection created the project it referenced. Fixed by running the projection first inside the same transaction (§5.1).

**Deltas cannot reconstruct an assistant message.** Thinking blocks carry signatures that must be echoed back to the API unchanged when a thread continues on the same model. Reconstructing from text deltas drops the signature and invalidates the turn. This is why the `agent.message` event stores raw content blocks verbatim — without it, threads would appear resumable and fail in practice.

### 7.3 Known gaps

- The browser half of Phase 1 has not been exercised interactively (Chrome extension unavailable). The page renders, the `/api` proxy works, and the build is clean, but the connect-and-subscribe path is unverified in a real browser.
- Next 15.5.25's Turbopack build fails on a packaging bug (looks for `server-external-packages.jsonc`, package ships `.json`). The webpack builder is used instead; `next.config.ts` carries an `extensionAlias` so webpack resolves the protocol package's NodeNext `.js` specifiers.

---

## 8. Remaining phases

Each phase ends at something demonstrable. Prefer finishing a phase's acceptance check over starting the next.

### Phase 2 — Container runtime

**Build** `images/base/Dockerfile` · `packages/runtime/{docker,ports,exec}.ts` · `ContainerReactor` · terminal pane in the UI.

Wire `terminal.create` / `input` / `resize` / `close` (already `passthrough` in `decide()`) to real exec streams, and publish `terminal.output`.

**Done when** a shell runs in a container from the browser, and killing the container surfaces as a clean error rather than a hang.

### Phase 3 — Gateway

**Build** `apps/gateway` per §6.1 · Traefik wildcard labels · Cloudflare DNS-01 certificate.

`parseHost` is already written and tested — this phase wires it to a proxy.

**Done when** `php artisan serve --host=0.0.0.0` is reachable at its public URL **with assets loading**. Asset loading is the assertion that validates the whole routing decision; HTTP 200 on `/` alone would pass even with the design broken.

### Phase 4 — Git and workspaces

**Build** `packages/vcs` clone/status/diff/commit/push · file tree, editor, diff panes · GitHub OAuth end to end (`crypto.ts` and the OAuth routes exist; the clone path does not).

**Done when** a repo clones, a file edits, and a commit pushes to a `ucch/` branch.

### Phase 5 — Agent core

**Build** `packages/agent/{loop,registry,session-log}.ts` · `fs`, `search`, `shell` tool plugins · `AgentTurnReactor` · chat UI.

**Done when** the agent makes a real change to a Laravel app and the diff renders. Assert `usage.cache_read_input_tokens > 0` on repeat turns from the start — retrofitting cache discipline is far harder than building with it.

### Phase 6 — Checkpoints

**Build** `packages/vcs/checkpoint.ts` · `CheckpointReactor` · per-turn diff UI with revert · thread fork.

`thread.revert` and `thread.fork` decisions and their guards are already written and tested; this phase implements the effects.

**Done when** a turn reverts cleanly — files *and* chat together.

### Phase 7 — Previews

**Build** stack detection · build recipes (§6.6) · `PreviewReactor` · preview containers · TTL reaper · previews panel.

**Done when** a published preview URL serves a built Next.js app.

### Phase 8 — Hardening

**Build** context editing · compaction · idle reaper · resource limits · cost display · friendly gateway error pages.

**Done when** a 50-turn thread stays within budget with a non-zero cache hit rate.

---

## 9. Deployment

Deploy as a single **Docker Compose** application in Dokploy. All services join `dokploy-network`; project containers additionally join `ucch-projects`.

Dokploy's UI generates Traefik labels for exact hostnames only, so the wildcard router needs custom labels on the gateway service:

```yaml
labels:
  - traefik.enable=true
  - traefik.docker.network=dokploy-network
  - traefik.http.routers.ucch.rule=HostRegexp(`^.+\.ucch\.danialirfan\.dev$`) || Host(`ucch.danialirfan.dev`)
  - traefik.http.routers.ucch.entrypoints=websecure
  - traefik.http.routers.ucch.tls.certresolver=letsencrypt
  - traefik.http.routers.ucch.tls.domains[0].main=ucch.danialirfan.dev
  - traefik.http.routers.ucch.tls.domains[0].sans=*.ucch.danialirfan.dev
  - traefik.http.services.ucch.loadbalancer.server.port=8080
```

**Prerequisites, in order:**

1. Cloudflare DNS: `A ucch` and `A *.ucch` → VPS IP, **DNS-only (grey cloud)**. Proxying breaks arbitrary-port WebSockets and adds a second TLS layer.
2. A Cloudflare API token with `Zone:DNS:Edit`
3. A `letsencrypt` **DNS-01** resolver in Dokploy's Traefik static configuration — HTTP-01 cannot issue wildcards
4. `docker network create ucch-projects`
5. `mkdir -p /srv/ucch/workspaces && chown 1000:1000 /srv/ucch/workspaces`

Configuration is validated once at boot (`apps/server/src/config.ts`) and frozen; a missing value stops the process rather than surfacing three layers down at request time. `DEV_AUTH_BYPASS` is refused when `NODE_ENV=production` — an unauthenticated harness holding a Docker socket is a root shell on the host.

---

## 10. Verification

### Local development

`*.ucch.localhost` resolves to `127.0.0.1` automatically on Linux, so the full subdomain routing works locally with no hosts-file entries.

```bash
docker run -d --name ucch-pg-dev -e POSTGRES_PASSWORD=ucch -e POSTGRES_USER=ucch \
  -e POSTGRES_DB=ucch -p 55432:5432 postgres:16-alpine

DATABASE_URL='postgres://ucch:ucch@localhost:55432/ucch' pnpm --filter @ucch/db migrate

pnpm test                 # vitest
pnpm --filter @ucch/server dev
pnpm --filter @ucch/web dev
node scripts/smoke-phase1.mjs
```

### Test strategy

- **`decide()` is the highest-value surface.** Table-driven tests over (state, command) → events, no mocks. Every authorization and state-machine invariant belongs here.
- **Reactors** — `DrainableWorker.drain()` awaits real completion. **Never `sleep` in a test.**
- **Gateway** — unit-test `parseHost` across every pattern including malformed input; integration-test a WebSocket upgrade through the proxy.
- **Checkpoints** — capture, mutate, revert, then assert the tree hash matches *and* that HEAD, the current branch, and the stash are untouched.

### End-to-end acceptance

The acceptance test for the whole product, run against the deployed VPS:

1. Clone `laravel/laravel` into a fresh project
2. `composer install && php artisan serve --host=0.0.0.0` → assert the port event fires
3. Open `p8000-{hash}.ucch.danialirfan.dev` → assert 200 **and that CSS/JS assets load**
4. Prompt *"add a /health route returning JSON status ok"* → assert `agent.tool_use` events, a non-empty diff, and 200 from `/health` on the live URL
5. Revert the turn → assert the route is gone and the file matches the pre-turn tree
6. Re-run, commit, push → assert the commit lands on `ucch/{thread}` on GitHub
7. Publish a preview → assert `pv-{hash}` serves the built app
8. Repeat with a Next.js repo → additionally assert HMR WebSockets connect and hot-reload fires

**Caching canary:** after a 20-turn thread, assert `usage.cache_read_input_tokens > 0` on the majority of requests. Zero means a silent invalidator (a timestamp in the system prompt, non-deterministic tool ordering) and is a bug, not a tuning issue.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The Docker socket in `server` is effectively root on the host | Accepted for single-tenant. Isolated behind a narrow interface in `packages/runtime`, so swapping to a rootless socket proxy later touches one file. |
| Dev servers bind `127.0.0.1` and are unreachable | Three layers: injected `HOST=0.0.0.0`, explicit flags in canned commands, and detection with a rebind hint in the ports panel. |
| Wildcard certificate issuance fails | DNS-01 is the only path that issues wildcards. Verify with `curl -vI https://test.ucch.danialirfan.dev` before calling Phase 3 done. |
| Long threads blow context or cost | Caching → context editing → compaction, in that order, with the cache-hit assertion as the canary. |
| Disk fills from workspaces and previews | Preview TTL reaper; per-project disk usage in the UI; workspaces are plain directories, auditable with `du`. |
| Agent pushes to `main` | No `git_push` tool exists; push requires `admin` scope and a user action; commits go to a `ucch/` branch. |

---

## 12. Sources

- **T3 Code** — [repository](https://github.com/pingdotgg/t3code) · [internals overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) · [A deep dive into T3 Code, Flavio Copes](https://flaviocopes.com/t3-code/)
- **DeepSeek Harness** — [repository](https://github.com/deepseek-ai/deepseek-harness) · [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) · [product page](https://deepseek.com/harness/en/) · [The New Stack coverage](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- **Dokploy** — [docs](https://docs.dokploy.com/docs/core) · [Docker Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains) · [wildcard subdomain discussion](https://github.com/Dokploy/dokploy/discussions/2057) · [Secure wildcard subdomains in Dokploy/Traefik](https://www.naps62.com/posts/wildcard-ssl-in-dokploy)
