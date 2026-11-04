# UCCH solutions

Every significant problem UCCH has had to solve, and the solution that is in the code today. Each entry gives the **problem**, the **solution**, **where it lives**, and how it's **verified**. For what the features are, see [`spec.md`](./spec.md). For how the parts connect, see [`architecture.md`](./architecture.md).

Contents:
1. [Performance on a 4 vCPU / 8 GB box](#1-performance-on-a-4-vcpu--8-gb-box)
2. [Correctness of the event log](#2-correctness-of-the-event-log)
3. [Billing and credential safety](#3-billing-and-credential-safety)
4. [Untrusted repositories](#4-untrusted-repositories)
5. [Filesystem confinement](#5-filesystem-confinement)
6. [Authentication and authorization](#6-authentication-and-authorization)
7. [Agent reliability](#7-agent-reliability)
8. [Context, handoff and memory](#8-context-handoff-and-memory)
9. [Collaboration and conflicts](#9-collaboration-and-conflicts)
10. [Live previews](#10-live-previews)
11. [Git at scale](#11-git-at-scale)
12. [Operations: limits, alerts, metrics](#12-operations-limits-alerts-metrics)
13. [Web UI responsiveness](#13-web-ui-responsiveness)
14. [Smaller solutions worth knowing](#14-smaller-solutions-worth-knowing)

---

## 1. Performance on a 4 vCPU / 8 GB box

**Problem.** Under 50 users, the harness lagged and grew in memory. The 2026-10-24 investigation found seven causes. Six were architectural, not about Node.js:

| # | Cause |
|---|---|
| 1 | each tab pre-rendered 115 pages at sign-in and re-rendered them on a timer and after every `router.refresh()` |
| 2 | every page render ran an aggregate SQL query over every turn of every project |
| 3 | every command from every user, terminal keystrokes included, waited in one global queue |
| 4 | every streamed token was its own WebSocket frame, and the browser re-rendered the whole chat per token |
| 5 | one 372 MB Claude Code process per turn, 2 per user, no global cap |
| 6 | shells, git, ripgrep, LibreOffice, Chromium and dev servers shared 8 GB with no limits |
| 7 | the API process is single-threaded and replayed up to 1,000 events per subscribe |

**Solution.** Each cause was fixed where it lived, rather than by a rewrite:

| Fix | Where |
|---|---|
| Warmup loads a small, budgeted set of **data**, once, when the shell is idle; no page pre-rendering, no re-warm triggers, no boot gate | `apps/web/src/lib/warmup.ts`, `lib/preload.ts`, `components/route-warmup.tsx` |
| Data changes invalidate queries through a realtime cache bridge instead of `router.refresh()` | `lib/realtime-cache.ts`, `lib/use-invalidate.ts` |
| A `project_stats` projection replaces the aggregate query; `/api/bootstrap` trimmed | `apps/server/src/project-stats.ts`, `engine.ts` (`applyProjection`) |
| **Keyed engine queue**: one lane per project, `ENGINE_MAX_PARALLEL` lanes; commands from one socket keep their order | `apps/server/src/worker.ts` (`KeyedWorker`), `engine.ts` |
| **Terminal fast path**: keystrokes and resizes skip the engine and zod entirely | `ws.ts` (`terminalFrame`, `#onTerminal`) |
| **Delta coalescer**: tokens held up to `STREAM_FLUSH_MS` (40 ms) go out as one frame; the first token is never held; deltas go to the thread topic only | `delta-coalescer.ts`, `bus.ts` |
| **Client thread store**: durable messages memoised; only the streaming tail re-renders per frame; deltas are ephemeral | `apps/web/src/lib/thread-store.ts`, `components/project-chat.tsx` |
| **Batched replay**: one `replay` frame instead of hundreds of `push` frames | `ws.ts` (`#replayBatched`) |
| **One WebSocket per tab** (the chat moved onto the shared socket) | `lib/realtime.tsx` |
| **Bounded history cache** (`HISTORY_CACHE_EVENTS`), least-recently-used thread first | `eventstore.ts` |
| **Turn scheduler** with global caps and a visible queue | `turn-scheduler.ts` |
| **Terminal caps** in config; **document-job semaphore** (`DOC_JOBS_MAX`) | `terminals.ts`, `packages/agent/src/documents.ts` |
| **Server-side git cache**, file-watcher-driven, so 10 viewers cost one status | `git-cache.ts`, `file-watcher.ts` |
| Child processes start with a raised OOM score and lower CPU/IO priority | `child-priority.ts` |
| Heap flags per service, pool size, slow-only request logging, Postgres defaults for 8 GB | `deploy/s6/s6-rc.d/*/run`, `config.ts` |
| `@ucch/protocol/plain` keeps zod out of browser bundles; cmdk lists and the search panel load on demand | `packages/protocol/src/plain.ts`, `components/on-demand.tsx` |

**Verified.** The load kit in `scripts/load/` (50 simulated users for 10 minutes against the production image under `--cpus=4 --memory=8g`, plus Playwright measuring in real browsers alongside) was run before (2026-10-25) and after (2026-10-27):

| Metric | Before | After | Target |
|---|---|---|---|
| RSC requests caused by one fresh sign-in | 115 | 19 | ≤ 15 |
| RSC requests in other tabs when a member saves settings | 115 per tab | 0 | 0 |
| Sign-in submit → interactive shell | 1.99 s | 0.74 s | ≤ 2.0 s |
| Click → skeleton (p95) | 87 ms | 78 ms | ≤ 100 ms |
| Click → content, cached data (p95) | 121 ms | 108 ms | ≤ 150 ms |
| Click → content, cold data (p95) | 381 ms | 703 ms | ≤ 600 ms |
| Bootstrap server time, 200 projects / 20k turns (p95) | 74 ms | 4.7 ms | < 15 ms |
| Terminal keystroke echo (p95 / p99) | 2.7 / 7.3 ms | 1.7 / 4.1 ms | < 30 / < 60 ms |
| WebSocket frames per 2,000-token answer | 2,026 | 696 | ≤ 675 |
| Git processes per file-change burst, 10 viewers | 80 | 3 | ≤ 3 |
| Concurrent `claude` processes in a 20-turn burst | 20 (uncapped) | 5, all 20 completed | ≤ cap, none failed |
| Subscriptions per socket / sockets per tab | 22+1 over 2–3 sockets | 4 on 1 socket | ≈ 4 / 1 |
| API RSS under load | 352 MB | 268 MB | < 1.2 GB |
| Event-loop delay p99 under load | 14 ms | 12.9 ms | < 50 ms |
| Shell-route first-load JS | 314 kB gz | 277 kB gz | ≤ 285 kB |

Three figures are just off target: sign-in RSC requests (19 vs 15), cold-data clicks (703 vs 600 ms) and frames per answer (696 vs 675). They're listed in [`spec.md` Open work](./spec.md#open-work). Re-run with `bash scripts/load/profile.sh <label>` and `node scripts/load/summarise.mjs documentation/perf/<label>` (see `scripts/load/README.md`).

---

## 2. Correctness of the event log

**Problem.** With a global queue gone, invariants that the queue had protected by accident had to be protected on purpose: two appends to one stream racing for a sequence number, or two messages sent to one thread at once.

**Solution.**
- **Stream lock and project-scoped sequence numbers.** `EventStore.append` takes a per-stream advisory lock, and `(stream, seq)` is unique, so a race fails loudly instead of interleaving (`eventstore.ts`).
- **A send claims the thread.** `thread.send` moves the thread to `queued` inside `decide()`, so a second send is refused with a conflict. A turn that never started is closed with `turn.dequeued` (`decide.ts`, `agent.ts`).
- **Projections in the same transaction** as the append (`applyProjection`). A `ProjectionConflict` aborts both.
- **The log as the record of intent.** Decisions emit intent, and reactors record the outcome, so "asked for" and "happened" are both in the log.
- **Unanswered tool calls are filled in.** A crash between dispatching a tool and recording its result would leave an assistant message with a dangling `tool_call`, which OpenAI-shaped APIs reject. `session-log.ts` writes a placeholder result, so any prefix of the log can be rebuilt.

**Verified.** `decide.test.ts`, `eventstore.test.ts`, `engine.test.ts`, `ws.test.ts` (commands from one socket arrive in the order sent).

---

## 3. Billing and credential safety

**Problem.** A subscription CLI that finds `ANTHROPIC_API_KEY` in its environment silently switches to pay-per-token billing. OMP reads dozens of provider keys from the environment before any login. One stray variable could put a turn on a bill nobody chose.

**Solution.**
- **CLI deny list.** `FORBIDDEN_ENV` (`packages/providers/src/types.ts`) is stripped from every Claude Code and Codex environment, and `forbiddenEnvPresent` refuses to start a run that still sees one.
- **OMP allowlist.** OMP gets exactly `OPENROUTER_API_KEY`, decrypted for one spawn. Any `*_API_KEY` or `*_OAUTH_TOKEN` outside the allowlist refuses the run (`omp-credentials.ts`, `forbiddenEnvFor("omp", env)`).
- **Never `--bare`** for Claude Code: it ignores OAuth and fails every subscription run. A test fails if it ever appears in `claudeArgv`. **Never `--ephemeral`** for Codex: it drops the rollout file `exec resume` needs.
- **Credential directories per subject.** `CREDS_ROOT/{userId}/{claude,codex,omp}`, or `ws-<workspaceId>` for a workspace's dedicated subscription. They're `0700`, and the server names the directory but never parses it (`providers.ts`).
- **Whose bill.** A workspace's `credential_policy` (`member`, `workspace`, `either`) decides whether turns run on each member's own subscription or the workspace's. A fixed policy applies to old threads too (`effectiveCredentialSource`, `packages/protocol/src/workspace-roles.ts`).
- **The bridge's key lives in the bridge's environment**, not the CLI's, so the CLI stays on its subscription while bridge calls bill OpenRouter (`omp-bridge-config.ts`).
- **Secrets at rest** are AES-256-GCM with `SECRET_KEY` (`crypto.ts`): OpenRouter, GitHub, Resend and Claude tokens, database passwords, project keys. Tampered ciphertext fails to decrypt.
- **Tokens never on a command line.** Git gets its token through an environment variable read by a credential helper (`git-exec.ts`), because `/proc/*/cmdline` is world-readable.

**Verified.** `claude.test.ts`, `codex.test.ts`, `omp-credentials.test.ts`, `omp-guard.test.ts`, `providers.test.ts`, `crypto.test.ts`, `git-exec.test.ts`.

---

## 4. Untrusted repositories

**Problem.** UCCH clones anything. A repository can ship agent configuration that runs code or changes approvals: `.claude/settings.json`, Codex rules, `.omp/hooks/*.ts`, `.omp/config.yml` setting `bash: allow`, LSP or DAP configs with arbitrary commands, MCP server definitions.

**Solution.**
- Claude Code runs with `--setting-sources user`, and Codex with `--ignore-rules`.
- OMP runs with `--no-extensions --no-rules --no-title` and a **guard hook** (`packages/providers/assets/omp-hooks/ucch-guard.ts`, the one hook that loads under `--no-extensions`). The hook refuses a `task` naming a non-bundled agent, among other things.
- **Per-turn OMP overlay** (`omp-overlay.ts`): OMP merges config records key by key, so a key the overlay doesn't write belongs to the repository. The overlay therefore writes every tool of the pinned version into `tools.approval`, every model role into `modelRoles`, and every switch that starts paid, outward-facing or process-spawning work.
- **Trust is opt-in per project** (`projects.omp_trusted`, `PATCH /api/projects/:hash/omp-trust`, needs `workspace.manage`). Untrusted projects run `--no-lsp` with `debug.enabled: false`. Trusted ones enable the repository's LSP and DAP; hooks, MCP, skills, commands and rules stay off either way.
- **Bridge calls** add their own guard overlay last. It denies subagents every tool the call didn't name: measured, `--tools` alone did not stop a `reviewer` subagent getting `bash`. It also turns off web search, telemetry and project-scope config (`packages/omp-bridge/src/guard.ts`).
- **Agent knowledge from the repository** (AGENTS.md / CLAUDE.md) is passed as text, capped at 16 KB.

**Verified.** `omp-overlay.test.ts`, `omp.test.ts`, `guard.test.ts`, and the OM0.4 probe repository (`scripts/omp/probe-safety.mjs`), which plants every project-scope source. None loaded untrusted; only LSP and DAP loaded when trusted.

---

## 5. Filesystem confinement

**Problem.** The browser's file editor and the agent's tools both take paths from untrusted input (a person or a model). A path that is lexically inside the workspace can still escape through a symlink (`dir -> /etc`, which git preserves). Writing into `.git` can plant commands that the server's next `git status` runs (`core.fsmonitor`, hooks).

**Solution.**
- **One normaliser** for every caller: `normalizeWorkspacePath` in `packages/protocol/src/paths.ts`, shared by `decide()` and the agent's `Executor.resolve()`, so the two can't drift.
- **`confine.ts`** (`packages/agent/src/executors/`) refuses any path with a symlink along it and any write into `.git`. It's shared by the executor and the server's file routes (`files.ts`).
- **Commands are argv arrays**, never shell strings. Prompts go on stdin. `ping` takes a hostname only through a regex that admits no leading hyphen (`tools/system.ts`).
- **Uploads are staged outside every tree** (`WORKSPACE_ROOT/.uploads/{projectId}`). No file tool, `bash` or the file panel can see one until `attach_upload` (or the attach route) moves it in.
- **Tree ids are database ids or hashes**, never caller text (`trees.ts`), so a worktree path can't climb out of the root.
- **Served files** get their `Content-Type` from the extension, never by sniffing, under `nosniff` and a sandboxing CSP. HTML is never served inline (`packages/protocol/src/media.ts`, `/file/raw`). PDFs open in a sandbox-compatible viewer (`pdf-viewer.tsx`).

**Verified.** `host.test.ts`, `files.test.ts`, `paths.test.ts`, `media.test.ts`, `uploads.test.ts`.

**Limit.** This is confinement, not isolation. The terminal and `bash` run as the container's `node` user and can read other projects. See [architecture §8.1](./architecture.md#81-the-single-container-production).

---

## 6. Authentication and authorization

**Problem.** A WebSocket can't carry an `Authorization` header, a long-lived token in a URL leaks, and holding an authenticated socket mustn't mean permission to do everything. Every account gets a shell, so open sign-up would be a disaster.

**Solution.**
- **Sessions in Postgres, tickets in memory.** The browser trades its cookie for a short-lived, single-use ticket over HTTPS and spends it on the `/ws` upgrade (`auth.ts`). Losing tickets on restart is correct.
- **Per-command scopes.** Every command has a `REQUIRED_SCOPE` (`read`, `write`, `exec`, `admin`) checked at the gateway (`packages/protocol/src/rpc.ts`). Then `decide()` checks the workspace role's permission.
- **Roles and permissions** (`plain.ts`): `owner` (everything), `admin` (all but deleting the workspace or touching the owner), `member` (view, create projects, write, start sessions), `viewer` (view). Per-member overrides exist for `canCreateProject` and `canCreateSession`. The owner's overrides are ignored, so the owner can never be locked out. The UI hides exactly what the server would refuse, because both import the same table.
- **Revalidation.** A membership change or a sign-out re-checks every open subscription. A revoked session gets a `revoked` frame (`ws.ts` `revalidate`, `closeSession`).
- **GitHub admission.** Only logins in `GITHUB_ALLOWED_USERS` or members of `GITHUB_ALLOWED_ORGS` may create an account. With neither set, only existing accounts can sign in (`github-admission.ts`).
- **Startup refusals.** No way to sign in → refuse to start. `DEV_AUTH_BYPASS` in production → refuse to start (`config.ts`).
- **Passwords** use scrypt with explicit cost parameters (`password.ts`). Login is rate-limited to 20 tries a minute per address, and the unauthenticated `/api/public/*` routes to 120 a minute, so share slugs can't be guessed quickly (`@fastify/rate-limit`, `index.ts`).
- **Invites** are stored as hashes and shown once. Joining is a click, so a link preview bot can't join anyone (`workspace-members.ts`, `invite-accept.tsx`).
- **Whole-API guards** (`http-guards.ts`): request checks that apply to every route, kept separate so they can be tested without booting the server.

**Verified.** `auth.test.ts`, `realtime-acl.test.ts`, `workspace-members-routes.test.ts`, `github-admission.test.ts`, `http-guards.test.ts`, `password.test.ts`.

---

## 7. Agent reliability

| Problem | Solution | Where |
|---|---|---|
| Weaker models send `"5000"` for a number, quoted booleans, objects as JSON strings, or omit nullable fields | repair exactly the type errors zod reports, narrowly, instead of bouncing the call | `packages/agent/src/arguments.ts` |
| Tool order changing between turns silently invalidates the prompt cache | one frozen array of tools; presets filter but never reorder | `packages/agent/src/registry.ts` |
| A model that calls tools forever costs money every iteration | `AGENT_MAX_ITERATIONS` (25), reported as `stopReason: max_iterations`, not as a failure | `loop.ts`, `config.ts` |
| One `bash` printing 40 MB would blow the context window; some providers reject an empty result | every tool result is bounded and never empty | `tools/format.ts` |
| A turn over the server's capacity used to fail outright after it had started | it waits before it opens (no `turns` row, nothing billed), and the thread shows how many are ahead | `turn-scheduler.ts` |
| A CLI paused on a tool its permission mode doesn't cover would hang | the request becomes `agent.permission_requested`, shown above the composer; the reply flows back to the CLI. "Allow all" for the rest of the session is one button | `permissions.ts`, `agent.ts` (`#approveNative`, `allowAllFor`), `permission-prompt.tsx` |
| Usage limits look like a broken integration | limit errors are classified (`agent.turn_failed{limit:true}`) from each CLI's own wording and events; optional automatic handoff to a fallback provider, once per chain | `claude.ts`, `codex.ts`, `agent.ts` (`#handOffOnLimit`) |
| A Mermaid diagram written by a model often doesn't parse (`@`, quotes, `/` in labels) | every node and edge label is rewritten to the one quoted form the grammar always accepts | `mermaid-repair.ts` |
| A stale stack label after the project changes | stack re-detected every 5 turns | `agent.ts` (`shouldRecheckStack`) |
| Research tools must not change the cached tool block when a backend changes | one seam per backend; names and schemas stay fixed | `packages/agent/src/web.ts`, `research.ts` |
| A gated page costs the model a failed call and a retry | `research_read` escalates to the Browser Use agent inside the same call | `tools/research.ts` |
| Document rendering loops forever on a broken file | at most two review rounds; three failed renders of one file stop the repair loop | doc kit, `tools/documents.ts` |

---

## 8. Context, handoff and memory

**Problem.** Long threads ended in a provider 400 for overflowing the context window. Moving work between Claude Code, Codex and OMP when a quota runs out had no path: there's no non-interactive import of one CLI's session into another.

**Solution.**
- **Native threads**: two escalations before a normal turn. First, **prune** the oldest tool results, which are the largest and stalest. Then **compact** the older half into one summary on `SEARCH_MODEL` (`packages/agent/src/context.ts`). A single token estimate (4 characters per token, `packages/protocol/src/tokens.ts`) is shared by the server's decision and the composer's meter, so the two can't disagree.
- **OMP threads**: `/compact [focus]` and `/handoff [focus]` run OMP's own commands on its session (`thread.compact`, `thread.handoff`).
- **The context meter** shows the last completed turn's measured prompt and reply, not a live guess (`context-meter.tsx`).
- **Cross-provider handoff** (`/continue <harness>`, `thread.handoff_to`):
  1. The source thread is claimed.
  2. Its log is rendered to plain text (`renderTranscript`).
  3. A one-shot `omp -p --no-session --no-tools` on `SEARCH_MODEL` writes a brief (`buildHandoffBrief`, `omp-handoff.ts`).
  4. A new thread opens **in the same worktree** (`worktreeOf`, `threads.tree_hash`), starting with the brief, and both threads link to each other with `thread.handed_off`.
  5. Sessions sharing a folder are counted, so only the last one out removes the worktree (`session-lifecycle.ts`).
- **Memory**: one mnemopi bank per project for OMP turns (workspace setting). With the bridge on, Claude Code and Codex get `omp_recall`/`omp_retain` on the same bank. They can optionally retain durable facts from each completed turn's final answer (never tool output) (`omp-memory.ts`, `agent.ts` `#retainAnswer`). The memory card shows counts, never contents.

**Verified.** `context.test.ts`, `omp-handoff.test.ts`, `handoff.spec.ts`, `compaction.spec.ts`, `omp-memory.test.ts`.

---

## 9. Collaboration and conflicts

**Problem.** Several people (and the agent) edit the same notes, files, boards and database rows. Last-write-wins loses work. Whole-row versions call it a conflict when two people changed different fields. Typing into a file while the agent rewrites it on disk must not lose either side.

**Solution.**
- **A separate collab process.** Hocuspocus runs in its own process (`collab.ts`, s6 service `collab`), so merging keystrokes never shares an event loop with the API. The API passes `/collab` upgrades through byte for byte (`collab-link.ts`). The two call each other on loopback with a secret derived from `SECRET_KEY` (`collab/secret.ts`).
- **Notes** are Yjs documents (`note_ydocs`). They're seeded once from `notes.content`, written back as ProseMirror JSON and plain text on save (debounced), and unloaded 30 s after the last editor leaves (`COLLAB_MAX_DOCS` cap). A schema-free ProseMirror ↔ Y.XmlFragment codec means the server needn't import every editor extension (`collab/prosemirror-y.ts`).
- **Files** open as Yjs text. A change on disk is merged in as one span: when the typing and the disk change don't overlap, both stay; when they do, the disk wins, since it's the newer write (`collab/file-merge.ts`, `packages/protocol/src/text-replacement.ts`).
- **Per-field guards** for the Tasks board and timeline. The client sends each changed field's starting value (`base`), and the write is refused only when that field changed meanwhile (`field-guard.ts`, `lib/field-edit.ts`). Writes are optimistic in the UI.
- **Database rows.** An edit is refused when the row no longer matches what the grid showed, and the dialog shows both versions (`database/browse-tab.tsx`, db-manager adapters).
- **Shared composer.** The prompt box of a thread is synced across tabs and people with a revision number (`composer.ts`, `lib/composer-sync.ts`). Presence shows who has which page open and who is typing, keyed by socket so one person in two windows shows twice (`presence.ts`).
- **Search-and-replace** replaces only the ranges the user saw and ticked, and only where the pattern still matches at that exact place. Moved lines are reported as stale rather than guessed at (`replace.ts`).

**Verified.** `notes.test.ts`, `collab` tests, `coedit.spec.ts`, `coedit-file.spec.ts`, `replace.test.ts`, `field-edit.test.ts`.

---

## 10. Live previews

**Problem.** A dev server needs a public URL. Path prefixes (`/{hash}/port:3000/`) break every target framework: Laravel's `/build/`, Vite's `/@vite/client`, Next's `/_next/`, HMR sockets built from `location.origin`. The preview host must not share the app's session cookie.

**Solution.**
- **Subdomains**: `p{port}-{hash}.<ROOT_DOMAIN>`. The hostname grammar is a pure function tested against hostile input (`packages/protocol/src/hostname.ts`). The project hash alphabet is DNS-safe with no hyphens (`ids.ts`).
- **The proxy sits in front of Fastify** (`preview.ts`), so a preview host's paths (`/api/me`, `/health`) never reach the API router.
- **Authorization by preview cookie.** `/{hash}/preview` on the main host checks membership and mints a single-use ticket. The preview host swaps it for its own host-scoped cookie, and the session cookie never leaves the root domain.
- **Only the stored port** is proxied, and the hostname is checked against it, so one project's cookie can't reach another port.
- HTTP and WebSocket upgrades are both proxied (Vite HMR works). Plain-HTML projects can preview a **folder** that the proxy serves itself.
- **Port detection** (`port-watcher.ts`) probes each watched project's port, only while someone is looking, and announces `port.opened` / `port.closed` instead of every tab polling.

**Verified.** `preview.test.ts`, `hostname.test.ts`, `port-watcher.test.ts`.

---

## 11. Git at scale

**Problem.** A status is three git processes and the Git view's reads seven. Ten viewers with the agent writing turned every burst of edits into 70–80 processes. Large clones are slow, and shallow clones confuse history.

**Solution.**
- **`git-cache.ts`**: status, branches and the first log page are computed once per working tree for every viewer. `file.changed` invalidates the status, a commit or push invalidates everything, and nothing is kept longer than its maximum age. The result was 80 → 3 processes per burst.
- **`file-watcher.ts`**: inotify per tree, only while someone has it open (plus a minute after). It watches `.git` and session worktrees, coalesces bursts, and doesn't echo the server's own writes. Events carry `worktreeId`.
- **The Git view is queries**, refreshed by events, with no polling (`components/git/use-git-state.ts`).
- **Status is capped** at a maximum number of changed files, because vendored trees can have far more (`git.ts`).
- **Clones report progress** and resume sensibly (`clone.ts`). A shallow clone's history shows what it has and offers the rest (`history-list.tsx`).
- **Sessions are worktrees** (`ucch/{hash}` branches beside the project), so several agents can work at once without touching the project's own checkout (`worktrees.ts`).
- **Connecting a remote** fetches and merges what the remote already holds before the first push, so the push isn't refused (`connect-remote-dialog.tsx`).

---

## 12. Operations: limits, alerts, metrics

| Problem | Solution | Where |
|---|---|---|
| A runaway dev server could take Postgres or the API down with it | children start with `choom -n 800 nice -n 10 ionice -c2 -n7` (terminals 500 / 5); never an address-space limit, because V8 reserves large ranges | `child-priority.ts` |
| No metrics at all | hand-rolled Prometheus `/metrics`: event loop, memory, GC, engine queue, WS frames, HTTP by route, web requests by kind, Postgres pool, web vitals by page template | `metrics.ts` |
| Where does memory go inside one container? | every 15 s, `/proc` and the cgroup files are read and grouped by service (`server`, `web`, `postgres`, `mysqld`) and by kind of child (`claude`, `shell`, `git`, …) | `resource-sampler.ts` |
| Trouble goes unnoticed without a monitoring stack | the watchdog alerts on memory > 85% for 2 min, event-loop p99 > 200 ms for 1 min, engine wait p99 > 500 ms for 1 min, or any OOM kill; at most once per 15 min per condition, to logs and `ALERT_WEBHOOK_URL` | `watchdog.ts` |
| Slow SQL is invisible | embedded Postgres loads `pg_stat_statements` and logs statements slower than `PG_LOG_MIN_DURATION_MS`; `scripts/pg-top.sh` prints the top 20 | `deploy/s6`, `scripts/pg-top.sh` |
| `NODE_OPTIONS` would leak heap flags into users' shells | heap limits go directly on each service's `node` command line | `deploy/s6/s6-rc.d/*/run` |
| A rolling deploy could start two Postgres servers on one volume | Dokploy update order must be stop-first; s6 stops the server first with 60 s to record in-flight work | README, `deploy/s6` |
| Who changed what | every write is recorded in `audit_log` and shown on the Activity page; repeated saves of one thing by one person fold into one line; bodies are never logged (no secrets or SQL) | `audit.ts`, `route-audit.ts` |
| Builds on the VPS | `image.yml` builds in CI and pushes to GHCR; Dokploy pulls it | `.github/workflows/image.yml` |

---

## 13. Web UI responsiveness

**Problem.** Clicks waited on the server, pages flashed "No items" before data arrived, and spinners hid frozen pages.

**Solution** (rules in `apps/web/CLAUDE.md`, enforced in part by `src/app/navigation.test.ts`):
- Every route has a `loading.tsx` that renders a skeleton matching the real layout (`page-skeletons.tsx`). The router prefetches down to that boundary, so every click paints in the same frame.
- Layouts await nothing. Lookups happen in a child under `<Suspense>`.
- Navigate only with `TransitionLink` / `useTransitionRouter`, and link to the final URL, not a redirect stub.
- Components track "loaded" separately from "empty". Spinners are for actions in flight only.
- The shell is a layout, kept across navigations. Rarely used dialogs, palettes and editors load on demand.
- A persisted query cache makes recent projects' content instant on reload.
- Long chats render only the streaming tail per frame. `turn-progress.tsx` shows elapsed time and tokens, so "working" is distinguishable from "hung".

---

## 14. Smaller solutions worth knowing

- **Avatars** are stored as `data:` URLs, shrunk in the browser and size-capped by a validator both sides share (`packages/protocol/src/avatar.ts`).
- **Search** uses ripgrep with no index, so a repository cloned 30 seconds ago is searchable and `.gitignore` is respected. Literal mode escapes regex metacharacters (`search.ts`).
- **Database manager**: every engine method opens and closes its own connection, because the servers are the user's and may be gone by the next request. SQL is split client-style so each statement gets its own result and error position (`DELIMITER` is refused). Identifiers are always quoted and data is always bound. A dump that fails midway ends with the error as its last line instead of an endless download (`db-manager/*`).
- **Dev databases** per project are created on the embedded (or configured) servers as the `dev` user, which can't reach the harness's own database (`dev-database.ts`, `deploy/postgres-init.sh`).
- **Model catalogue and quotas** are cached (`/api/models`; quota answers for a minute) and flattened to one "percent used, resets at" shape for three very different vendors (`quotas.ts`).
- **The browser never sniffs** what a file is: one extension table decides the preview element and the served type (`media.ts`).
- **Note search** walks ProseMirror JSON for the words a reader sees, not node names or whiteboard JSON (`note-text.ts`).
- **The app update prompt** appears when the server's `BUILD_ID` differs from the tab's (`lib/app-update.ts`, `update-toast.tsx`).
- **Workers have observable queues**, so tests await real completion instead of sleeping (`worker.ts`).
