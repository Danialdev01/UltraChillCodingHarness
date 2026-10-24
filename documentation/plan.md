# Rewriting UCCH in Rust: is it worth it?

**Status:** recommendation · **Date:** 2026-10-24 · **Target:** one Dokploy VPS, 4 vCPU / 8 GB RAM, 50+ concurrent users

The detailed design for every fix below is in [`solution.md`](./solution.md), and the ordered tasks are in [`todo.md`](./todo.md).

The previous plan in this file (single container, instant navigation, realtime) is in git: `git show HEAD:documentation/plan.md`.

---

## TL;DR

**Do not rewrite UCCH in Rust now.** It would cost months and fix the smallest part of the problem.

The lag and memory use come from **how the system is put together**, not from Node.js being slow:

| # | Cause | Where | Would Rust fix it? |
|---|---|---|---|
| 1 | Each browser tab pre-renders 115 pages at sign-in and re-renders them on a timer and after every `router.refresh()` | `apps/web/src/lib/warmup.ts`, `lib/preload.ts`, `components/route-warmup.tsx` | **No.** That is Next.js, which stays Node |
| 2 | Every page render runs an aggregate SQL query over every turn of every project | `apps/server/src/workspaces.ts:374` | **No.** The time is spent in Postgres |
| 3 | Every command from every user, **including each terminal keystroke**, waits in one global queue | `apps/server/src/engine.ts:39` | **No.** It is a design choice: keystrokes wait behind other users' DB-bound commands |
| 4 | Every streamed token is its own WebSocket frame, and the browser re-renders the whole chat per token | `packages/agent/src/loop.ts:263`, `apps/web/src/components/project-chat.tsx` | **No.** The browser work is the same |
| 5 | One Claude Code CLI process per agent turn (**372 MB RSS, measured**), up to 2 per user and **no global cap** | `apps/server/src/agent.ts:653` | **No.** The CLI is its own program |
| 6 | Shells, git, ripgrep, LibreOffice, Chromium and users' dev servers share the same 8 GB with no limits | `deploy/s6`, `Dockerfile` | **No** |
| 7 | The API process is single-threaded, runs zod on every inbound frame, and replays up to 1,000 events per subscribe | `apps/server/src/ws.ts` | **Yes**, partly |

Only row 7 is about the language. A Rust API would save about **0.2–0.5 GB of RAM** and could use all four cores. **One heavy user** (a Claude Code turn plus a Vite dev server) costs about **0.6 GB**. A full rewrite is ~33,000 lines of TypeScript, roughly **4–8 months** for one developer, during which the product stands still.

**Recommendation:**

1. **Measure** (2–3 days).
2. **Fix rows 1–6 in TypeScript** (1–2 weeks). Each fix is local, and together they should remove most of the lag.
3. **Add global limits and build images off the VPS** (2–3 days).
4. **Measure again.** Bring in Rust only if the API process is then the top consumer, and then only as a narrow "edge" daemon (public port, WebSocket fan-out, terminals, preview proxy) placed in front of the Node server, ported route by route.

Hosting 50 *heavy* users at once (each with an agent turn and a dev server) does not fit in 8 GB in **any** language; see [Capacity](#2-what-50-concurrent-users-costs). That needs global queues and caps, more RAM, or per-project containers spread over more machines.

> Numbers marked *est.* are estimates from general experience with these runtimes. They are not measured on this deployment. Numbers marked *measured* come from the Phase 0 baseline ([`perf/README.md`](./perf/README.md), `perf/baseline-2026-10-25.json`): the production image under `--cpus=4 --memory=8g` with 50 simulated users for 10 minutes, Postgres in a container of its own and a fake `claude` that holds no memory. The other measured figures are the Claude Code CLI's RSS (372 MB, a running `claude` process on the development machine) and the frontend baselines in `apps/web/e2e/results/`.

---

## 1. What runs on the box today

One container (`Dockerfile`, target `app`), supervised by s6-overlay (`deploy/s6/s6-rc.d/`):

| Process | Language | Notes |
|---|---|---|
| `server`: API, WebSocket, terminals, agent turns, preview proxy, and the public port :3000 | Node 22 (esbuild bundle) | Fastify 5, `ws`, drizzle + postgres.js (pool 10), `@lydell/node-pty`, `@parcel/watcher`, zod. No heap limit. |
| `web`: Next.js 15.5 standalone on 127.0.0.1:3100 | Node 22 | Every HTML and RSC request passes through `server` (`apps/server/src/web-proxy.ts`). No heap limit. |
| `postgres` 16 | C | `shared_buffers=256MB`, `work_mem=8MB` (overridable). |
| `mysql` (MariaDB) | C++ | Off unless `ENABLE_MYSQL=true`. |
| Children per user action | mixed | `claude` / `codex` CLIs (one per turn), login-shell PTYs, `git`, `rg`, Python doc-kit → pandoc, typst, LibreOffice, mermaid-cli → Chromium, and users' own dev servers (`php artisan serve`, Vite, `next dev`). |

Beside the container on the same VPS: Dokploy itself (its Node app, Postgres, Redis), Traefik, Docker, the OS, and **the image build** when you press Deploy.

### Code size

| Package | Lines (excl. tests) | Role |
|---|---|---|
| `apps/server/src` | 21,867 | API, WS, engine, reactors, git, terminals, previews, DB manager |
| `packages/agent/src` | 5,705 (+1.5k Python doc-kit) | native agent loop, tool registry |
| `packages/providers/src` | 1,752 | Claude Code / Codex CLI drivers |
| `packages/protocol/src` | 2,755 | zod wire schemas, shared with the web app |
| `packages/db/src` | 838 + 26 SQL migrations | drizzle schema, migrator |
| **Backend total** | **~32,900** | plus ~12,500 lines of tests |
| `apps/web/src` | 54,857 | Next.js UI; stays TypeScript in every option |

`apps/gateway`, `packages/runtime`, `packages/vcs` and `images/` are empty.

---

## 2. What "50 concurrent users" costs

"50 users at the same time" can mean very different loads. The model below separates three profiles.

### Fixed costs

| Item | Node today | With a Rust API |
|---|---|---|
| OS, Docker, Dokploy (app + Postgres + Redis), Traefik | ~0.8 GB (*est.*) | ~0.8 GB (*est.*) |
| PostgreSQL (256 MB buffers + ~10 backends) | 0.24 GB (*measured*) | 0.24 GB |
| Next.js server under load | 0.48 GB mean, 0.70 GB max (*measured*, private pages; still growing at the end of the run) | the same (unchanged) |
| API server | 0.31 GB mean, 0.35 GB max RSS (*measured*) | ~0.03–0.1 GB (*est.*) |
| **Total fixed** (at the maxima) | **~2.1 GB** | **~1.8 GB** |

That leaves **~5.9 GB** for users with Node and **~6.2 GB** with Rust. The difference between the two columns is about 0.25–0.3 GB.

### Per-user costs

| Profile | What they are doing | RAM per user | 50 of them |
|---|---|---|---|
| **Light**: connected | sidebar open, reading, navigating | Node ≤ ~2.6 MB (*measured* upper bound: the API's RSS grew 219 → 352 MB over the 50-user run), Rust <1 MB (*est.*) | ≤ ~0.13 GB |
| **Medium**: working | chatting with the **native** agent (OpenRouter, in-process) + 1 terminal | ~1–3 MB (*measured*: the image's login shell holds ~0.6 MB private, 16 shells 9 MB; the agent's state is inside the API's RSS above) | ≤ ~0.15 GB |
| **Heavy**: building | a **Claude Code** turn + a dev server | 372 MB (measured) + 150–300 MB Vite / 30–60 MB artisan / 0.5–1.5 GB `next dev` ≈ **~0.6 GB typical** | **~30 GB** |

**Reading the table:**

- 50 light or medium users fit comfortably once the fixes in §6 are in, in either language.
- About 8–9 heavy users at once fill the box. Rust's saving buys roughly one more.
- A realistic mix of 50 connected users, 15 using the native agent and 8 in heavy turns comes to ~0.13 + 0.05 + 4.8 ≈ **5.0 GB**. That fits, **but only with a global cap on concurrent CLI turns** (today there is none) so the 9th to 50th heavy turns queue instead of pushing the box into swap or the OOM killer.

### CPU

The four vCPUs are spent on:

- **Next.js renders.** A full RSC render with its API calls costs about 10 ms of CPU (*measured*: 12,295 renders in 0.19 cores over the 10-minute run). At sign-in each tab warms 115 routes (finding 1, *measured*), so 50 users signing in within a few minutes is ~5,750 renders ≈ 1 CPU-minute, concentrated in one Node process that can use only one core. This is the most likely source of "the whole thing is laggy" right after a deploy or in the morning.
- **Postgres** running the per-project aggregate (finding 2) for each of those renders.
- **Dev servers and CLIs.** Vite and `next dev` rebuilds, and Claude Code processing its stream.
- **The API process.** JSON, zod, fan-out. Single-threaded, so it saturates at one core, which is 25% of the box.

---

## 3. Where the time and memory go: findings

### Finding 1: the boot pre-render storm (web)

`lib/warmup.ts:58` sets `BUDGET = { projects: 20, sessionLists: 60, fileTrees: 5, hot: 5 }`. For each of the 20 most recent projects, `warmupPlan` prefetches the chat page plus 4 project pages, along with 5 data lists. Add the sections, workspace settings, home and settings pages, and it comes to **115 full RSC renders and 125 data requests per tab** (*measured* over the 40 s after a fresh sign-in), run 4 at a time (`lib/preload.ts:45`).

They are re-triggered:

- every ~5 min while the tab is active: the "hot" set, ~19 routes (`components/route-warmup.tsx:89`);
- when a tab returns after ~4 min hidden: everything (`route-warmup.tsx:86`);
- **2 s after any `router.refresh()`: everything** (`route-warmup.tsx:95`).

`lib/realtime.tsx:285` calls `router.refresh()` and `forgetPrefetched()` on settings events, so **one member saving project settings makes every other member's open tab re-render 115 pages (*measured*).** At 50 users that is a thundering herd of ~5,750 renders, each one hitting finding 2. `router.refresh()` is also called from about 20 other places in the UI.

**Rust:** no effect. These are Next.js renders.

### Finding 2: the bootstrap query on every render (server + SQL)

Every page render calls `GET /api/bootstrap` (`apps/web/src/lib/session.ts`, `components/app-shell.tsx`). That calls `workspaceService.listProjects` (`apps/server/src/workspaces.ts:374`), which selects every project in the workspace with **five correlated subqueries per project**: running?, last turn failed?, thread count, and two `SUM`s over **every turn's** JSONB `usage` and `cost_usd`. There is no limit and no cache. It grows with total history, not with activity.

**Rust:** no effect. The cost is in Postgres.

### Finding 3: one global command queue (server)

`OrchestrationEngine` (`apps/server/src/engine.ts:39–75`) runs **every** command from **every** user through one `DrainableWorker` that handles one item at a time (`worker.ts`). The comment explains why: no decision should run on stale state, which is "unambiguously the right way round" for a personal harness. With 50 people it is the wrong way round:

- `terminal.input` and `terminal.resize` are commands too. They carry only a `terminalId`, so `#loadState` makes no DB reads for them (`engine.ts:129–220`), and `decide()` passes them straight through (`decide.ts:355`).
- They still go through the global queue. So **each keystroke of each user waits behind every other user's commands**, including slow ones such as `thread.send`, which loads the thread, project and workspace and then appends events and updates projections in a transaction.
- Each keystroke also pays for a zod parse (`ws.ts:177`), the `onDispatched` audit hook, its own `ack` frame (`ws.ts:193–210`), and a pending-promise entry in the browser.
- 50 people typing ~5 characters/s is ~250 queued commands per second sharing one serial pipe with every chat send. The tail latency, keystrokes stuck behind a burst of sends, is what users feel as a laggy terminal.

`CloneReactor` and `WorktreeReactor` are also single global queues (`clone.ts:110`, `worktrees.ts:40`): one user's large clone delays everyone's.

**Rust:** a little. Rust shortens the CPU part of each item, but most of a command's time is spent waiting on DB round trips, and the serialization stays.

### Finding 4: one frame per token (server + browser)

- Every streamed token is an `agent.text_delta` event (`packages/agent/src/loop.ts:263`, `packages/providers/src/claude.ts:357`), published to both the `project:` and `thread:` topics (`bus.ts:90`). Each goes out as its own WebSocket frame. The body is serialized once per event (`ws.ts:574`), and a header is built per subscriber.
- In the browser, every frame is `JSON.parse`d and **zod-validated** (`apps/web/src/lib/client.ts:297`). The event array (up to 500) is copied, and `project-chat.tsx` re-derives all messages (`:384`, `:646`) and re-parses the streaming answer's Markdown. Cost grows with the square of the answer length. There is no `requestAnimationFrame` or transition batching and no list virtualization anywhere.
- Inbound, `ClientFrame.parse` (zod) runs on every frame (`apps/server/src/ws.ts:177`), including keystrokes.

**Rust:** server side, partly (serde is faster than JSON + zod). Browser side, no, and that is where the stutter is.

### Finding 5: CLI processes, uncapped globally

Each Claude Code turn starts `claude -p --output-format stream-json …` as a new process (`packages/providers/src/claude.ts:73`). Claude Code is itself a Node application: **372 MB RSS** measured. Each Codex turn starts `codex exec` (a native binary, lighter; ~30–100 MB *est.*). The only limit is `AGENT_MAX_CONCURRENT_PER_USER` (default 2, `apps/server/src/config.ts:140`, `agent.ts:653`), so 50 users can start ~100 CLI processes, ~37 GB worth of Claude Code. There is no global limit and no queue.

Also uncapped globally:

- **PTYs.** Each is a login shell (`fish -l` or `bash` with the user's rc), 10 per project, 15 min idle timeout, no per-user or global cap (`terminals.ts:35,49`).
- **Git.** One `status()` is 4 git processes (`git.ts:97`). The Git view in every visible tab polls status + branches + log every 60 s and after every burst of file changes (`apps/web/src/components/git/use-git-state.ts:28`), 8 processes per refresh per tab (*measured*: 80 for one burst with 10 viewers), repeated by every viewer of the same project.
- **Document pipeline.** LibreOffice (~200–500 MB *est.*) and Chromium for Mermaid (~150–300 MB *est.*) on demand.

**Rust:** no effect. These are separate programs.

### Finding 6: one box, no limits, builds on the same box

- No `--max-old-space-size` on either Node process (`deploy/s6/s6-rc.d/{server,web}/run`), no container memory or CPU limit, no per-child limit. One runaway dev server or document conversion can push the API and Postgres into swap.
- No metrics: `/health` reports status and connection count only. There is no event-loop delay, RSS per service or `pg_stat_statements`, so the current "laggy" diagnosis rests on feel.
- Dokploy builds the image **on the VPS** (~10 minutes, compiling Next.js) while users are on it. A Rust release build would add ~5–15 minutes and 2–4 GB of peak RAM (*est.*).

**Rust:** no effect, and it makes the build problem worse.

### Finding 7: the API process itself

What Rust would actually improve:

- Node runs the JavaScript on **one thread**: one of four cores. Tokio would use all four.
- zod on every inbound frame and ~137 other parse sites; serde with derived types is several times cheaper.
- Thread subscribe replays up to 1,000 events, one frame and one `JSON.stringify` each (`ws.ts:20`, `ws.ts:292`).
- `threadHistory` caches the **entire** history of the 32 most recent threads with no per-thread size bound (`eventstore.ts:137`, `:168`).
- GC pauses add tail latency under allocation-heavy fan-out.

These are real, but each one also has a cheap TypeScript fix (§6), and the process is only one of several large consumers.

---

## 4. Node vs Rust for this workload

| Dimension | Node 22 (today) | Rust (axum + tokio) | Matters here? |
|---|---|---|---|
| Idle RSS of the API | 219 MB (*measured*, before load) | ~10–40 MB (*est.*) | A little: ~0.2 GB (352 MB under load) |
| Memory per WebSocket | ~20–50 KB + JS objects (*est.*) | ~5–15 KB (*est.*) | No: 50 users × 2 sockets is a few MB either way |
| CPU cores used | 1 for JS (libuv pool for fs/crypto) | all 4 | **Yes**, if the API is CPU-bound |
| JSON + validation | `JSON.parse` + zod: zod v3 is often several times slower than the parse itself | serde, typed | Some: frames per token |
| Tail latency | GC pauses | none | Some |
| Next.js SSR | Node | **still Node** | Biggest CPU cost; unchanged |
| CLIs, shells, git, LibreOffice, dev servers | separate processes | **the same processes** | Biggest RAM cost; unchanged |
| Postgres queries | same | same | Finding 2 unchanged |
| Build time / RAM | esbuild, seconds | cold release build ~5–15 min, 2–4 GB (*est.*) | **Worse** on a 4 vCPU box |
| Image size | 2.66 GB (mostly LibreOffice, Chromium) | about the same: Node stays for Next.js, Claude Code, mermaid-cli | No change |
| Shared types with the UI | zod schemas compiled into both sides; cannot drift | needs codegen (`ts-rs` / `specta`, or JSON Schema) | Ongoing cost |
| Developer velocity | one language across 88k lines | two languages; Rust compile times | **Yes**, for a small team |

### Library mapping

| Today | Rust equivalent | Fit |
|---|---|---|
| Fastify 5, @fastify/cookie, compress, rate-limit | `axum`, `tower-http`, `tower_governor` | Good |
| `ws` | `axum` WebSocket / `tokio-tungstenite` | Good |
| postgres.js + drizzle | `sqlx` (compile-checked SQL) | Good; the TS schema types are lost |
| drizzle migrator (`packages/db/src/bootstrap.ts`) | `sqlx migrate` / `refinery` over the same SQL files | Needs a one-time baseline of drizzle's migrations table |
| `mysql2` (DB manager) | `sqlx` (MySQL) / `mysql_async` | Good |
| `@lydell/node-pty` | `portable-pty` | Good |
| `@parcel/watcher` | `notify` | Good |
| `node:http` proxy (`web-proxy.ts`, `preview.ts`) | `hyper` / `hyper-util` | Good, and faster |
| scrypt (`password.ts`, `scrypt$N$r$p$salt$key`) | RustCrypto `scrypt` | Compatible |
| AES-256-GCM (`crypto.ts`) | RustCrypto `aes-gcm` | Compatible, same `SECRET_KEY` |
| fetch + hand-rolled SSE to OpenRouter (`openrouter.ts`) | `reqwest` + `eventsource-stream` | Good; no SDK is used today |
| CLI stdio JSONL drivers (`packages/providers`) | `tokio::process` + serde | Good |
| zod (`packages/protocol`, agent tool schemas) | serde + `validator` / `garde`, `schemars` for tool JSON Schemas | Works; duplicated contract |
| Planned Yjs / Hocuspocus co-editing (todo R8) | `yrs` for the CRDT | **Gap:** y-prosemirror / Tiptap Markdown conversion exists only in JS, so it would need a Node sidecar |

---

## 5. What a full rewrite costs

**Scope:** ~33k lines of backend TypeScript and ~12.5k lines of tests. Rust ports usually come out 1.2–1.5× longer.

**Estimate:** **4–8 months** for one developer, at the upper end if Rust is new to them (*est.*). Either features freeze or both versions are maintained at once.

**What must stay compatible** so the existing `/data` volume and browser sessions keep working:

| Contract | Where it lives today |
|---|---|
| Database schema, event log, and drizzle's migration history | `packages/db/src/schema.ts`, `packages/db/migrations/` |
| Password hash format | `apps/server/src/password.ts` |
| Encrypted secrets (API keys, DB connections) with the existing `SECRET_KEY` | `apps/server/src/crypto.ts`, `/data/secrets/secret_key` |
| Session cookie, WS ticket and preview ticket semantics | `apps/server/src/auth.ts`, `preview.ts` |
| WebSocket frame protocol and every event type | `packages/protocol/src/{events,commands}.ts` |
| Preview hostname grammar `p{port}-{hash}` | `packages/protocol` (16 tests against hostile input) |
| Event-sourcing semantics: pure `decide()`, projections in the append transaction, reactors after commit | `decide.ts`, `engine.ts`, `eventstore.ts` |
| Claude Code / Codex stream parsing, permission prompts, resume | `packages/providers/src/{claude,codex}.ts` |

**Risk:** high. The parts most likely to break, such as the CLI stream parsers, permission-prompt flow, preview proxying with HMR, and event replay, are exactly the parts users touch most. Findings 1–6 would still be there afterwards.

---

## 6. Recommended plan

### Phase 0: measure (2–3 days)

The lag is currently judged by feel. Make it a number before changing anything.

- **API process:** `perf_hooks.monitorEventLoopDelay()` (p50/p99), `process.memoryUsage()`, queue depth of the orchestration worker, frames/s and bytes/s per topic. Expose them at `GET /metrics` (bearer token, or loopback only).
- **Per service:** RSS and CPU of each s6 service and of spawned children (`/proc/<pid>/status`, or `ps` grouped by parent), logged every 30 s.
- **Postgres:** enable `pg_stat_statements` and record the top queries by total time.
- **Load script:** a k6 (WebSocket) or Playwright script for 50 simulated users: sign in, navigate, stream a chat turn, type in a terminal, open the Git view. Run it against the production image (`docker compose up`) with `--cpus=4 --memory=8g` to mimic the VPS. Save results in `documentation/perf/`.

**Exit:** a table of who uses the CPU and RAM under 50 users, plus p95 keystroke-echo and token-to-paint latency.

### Phase 1: fix the architecture in TypeScript (1–2 weeks)

Ordered by expected impact (*est.*):

| Fix | Files | Expected effect |
|---|---|---|
| **Shrink the warmup.** Prefetch on intent (hover/viewport) plus ~3 recent projects, not 20; no full re-warm after `router.refresh()`; replace `router.refresh()` on realtime events with TanStack Query invalidation of the affected keys | `lib/warmup.ts`, `lib/preload.ts`, `components/route-warmup.tsx`, `lib/realtime.tsx`, `lib/realtime-cache.ts` | ~10–30× fewer Next renders at sign-in; removes the settings thundering herd |
| **Make `listProjects` cheap.** Keep `thread_count`, `tokens`, `cost_usd`, `running`, `last_failed` in a `project_stats` projection updated in `applyProjection`; read it in one join | `apps/server/src/workspaces.ts`, `engine.ts`, new migration | Bootstrap goes from "scan all turns" to an index lookup |
| **Take terminals off the global queue.** New ack-less `terminal_input` / `terminal_resize` frames go straight to the terminal reactor after a claim check. Split the engine queue per project, after making event sequence numbers and the one-turn-per-thread rule safe without it (`solution.md` §2, §6) | `apps/server/src/{engine,worker,eventstore,ws,terminals}.ts` | Keystroke latency independent of other users |
| **Coalesce tokens.** Server: buffer `text_delta` per turn and flush every 33–50 ms. Client: batch frames per `requestAnimationFrame`, memoize finished messages, re-parse only the streaming tail, and drop the zod parse for hot frame types | `apps/server/src/agent.ts` (the `append` closure every turn type passes through), `apps/web/src/lib/client.ts`, `components/project-chat.tsx` | ~3–5× fewer frames; smooth streaming |
| **Global caps with queues.** `AGENT_MAX_CONCURRENT_TOTAL` (start at ~6 Claude Code turns) with a visible "queued" state; a global PTY cap; one document job at a time | `apps/server/src/agent.ts`, `config.ts`, `terminals.ts` | No OOM from bursts; predictable memory ceiling |
| **Shared git status.** One server-side status per project, recomputed on watcher events (debounced) and pushed to all viewers; drop the 60 s client poll | `apps/server/src/git.ts`, `file-watcher.ts`, `apps/web/src/components/git/use-git-state.ts` | Git processes per change: per project, not per tab |
| **Bound the caches and replays.** Size-bound `threadHistory`; send replays as one batched frame | `apps/server/src/eventstore.ts`, `ws.ts` | Lower, flatter API memory |
| **Runtime limits.** `--max-old-space-size` on both Node services; raise the DB pool to ~20 and tune `work_mem` after Phase 0 | `deploy/s6/s6-rc.d/{server,web}/run`, `packages/db/src/index.ts` | Node gives memory back instead of growing until swap |

Then finish the open items in `todo.md` that overlap: **B8** (one WebSocket per tab) and **B11** (bundle budgets: −2% of a −25% target so far).

### Phase 2: operations (2–3 days)

- **Build off the VPS.** A GitHub Actions workflow builds the `app` target and pushes it to GHCR. In Dokploy, switch the application's provider from *Git + Dockerfile* to *Docker image* and redeploy via webhook. The VPS then never compiles, which matters even more if Rust is ever added. (Same Dockerfile, so `docker build .` keeps working locally.)
- **Resource limits.** In Dokploy → *Advanced → Resources*, cap the container at ~7 GB so the host and Dokploy survive. Start heavy children (`claude`, `soffice`, `mmdc`, dev servers) under `prlimit --as=…` or a cgroup slice so one of them can't take the server with it.
- **Alerts** on RSS and event-loop p99 from `/metrics`.

### Phase 3: measure again and decide

Re-run the Phase 0 script. Consider Rust only if **all** of these hold **after** Phase 1:

- [ ] the API process is the top CPU consumer in the container (>50% of total), **or** its event-loop p99 is >50 ms under the 50-user script;
- [ ] its RSS is >1 GB, or its GC is visible in latency traces;
- [ ] the remaining cost is in the edge layer (WebSocket fan-out, PTYs, proxying), not in Postgres, Next.js or child processes.

If it qualifies, **don't rewrite; put a Rust edge in front** (strangler pattern, the same shape as today's `web-proxy.ts`):

```
browser ──► :3000  ucch-edge (Rust: axum + tokio)
                    ├─ /ws            WebSocket fan-out (events pushed from Node over a Unix socket)
                    ├─ terminal I/O   PTYs owned here (portable-pty), authorized via Node once
                    ├─ p{port}-{hash} preview proxy (hyper)
                    ├─ /_next/static  served from disk
                    └─ everything else ──► Node server (127.0.0.1:3001) ──► Next.js (127.0.0.1:3100)
```

Move routes into the edge one at a time, verified by the same smoke tests (`scripts/smoke-phase1.mjs`, `scripts/smoke-container.sh`). The domain logic (`decide`, projections, agent loop, CLI drivers) stays in TypeScript unless measurements say otherwise. A full rewrite then becomes an option, not a requirement. *Est.* 4–8 weeks for the edge.

### Longer term: isolation beats language

The biggest lever for "50 users on one box" is **per-project containers with cgroup memory and CPU limits**: the planned `packages/runtime` and `images/base`, currently empty. They make each user's dev server and agent tools bounded and killable, close the shared-`node`-user isolation gap the README warns about, and are the step that later allows spreading projects over a second machine.

---

## 7. Deployment and compatibility with Dokploy

**A Rust server is fully compatible with the current deployment.** It is one more stage in the same multi-stage `Dockerfile`, and Dokploy's *Dockerfile* build type, the single port 3000, the `/data` volume and `stop-first` updates all stay the same.

```dockerfile
# --- rust build (sketch) ------------------------------------------------------
# Debian bookworm like every other stage, so the binary links against the same
# glibc as the runtime image. Pin the toolchain to an exact version.
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /src

FROM chef AS rust-plan
COPY crates/ ./crates/
COPY Cargo.toml Cargo.lock ./
RUN cargo chef prepare --recipe-path recipe.json

# Dependencies first, in their own layer: a code change recompiles only our crates.
FROM chef AS rust-build
COPY --from=rust-plan /src/recipe.json .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo chef cook --release --recipe-path recipe.json
COPY crates/ ./crates/
COPY Cargo.toml Cargo.lock ./
COPY packages/db/migrations ./migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --locked --bin ucch-edge \
  && strip target/release/ucch-edge

# --- app: unchanged except for one COPY and one s6 service --------------------
FROM toolchain AS app
# ...existing s6 / postgres / web / server steps...
COPY --from=rust-build /src/target/release/ucch-edge /usr/local/bin/ucch-edge
```

| Concern | Answer |
|---|---|
| Dokploy build type | Unchanged: *Dockerfile*, last stage `app`. |
| Base image / libc | `rust:1-bookworm` → copied into the bookworm `toolchain` stage. Same glibc; no musl needed. |
| Node still needed in the image? | **Yes.** Next.js, the Claude Code CLI and mermaid-cli are Node programs. The image does not shrink much (2.66 GB, mostly LibreOffice and Chromium). |
| Process supervision | A new `deploy/s6/s6-rc.d/edge/` service; `server` moves to 127.0.0.1:3001. Graceful drain on `SIGTERM` (tokio signal handler) within `S6_KILL_GRACETIME`. |
| Ports, volume, health check | Same: :3000, `/data`, `GET /health` (the edge answers and checks Node behind it). |
| Secrets | Read from `/data/secrets` as today, before dropping to `node` (`setpriv`, as in `s6-rc.d/server/run`). |
| Migrations | Keep running them from Node during the transition. A full port switches to `sqlx migrate` with a one-time baseline of drizzle's `__drizzle_migrations` table. |
| Build cost | Cold release build ~5–15 min and 2–4 GB RAM on 4 vCPU (*est.*); warm (deps cached by cargo-chef) ~1–3 min. **Build in CI (Phase 2)** so this never runs next to live users. |
| Rollback | The edge forwards anything it doesn't handle to Node, so removing it is one s6 service and one `PORT` change. |
| Local dev | `cargo watch -x run` beside `pnpm dev`; `scripts/dev.sh` would start both. |
| Type sharing with the UI | Generate TypeScript from Rust types (`ts-rs` or `specta`) into `packages/protocol`, checked in CI so the two sides cannot drift. |

---

## 8. Decision summary

| Question | Answer |
|---|---|
| Will Rust fix the lag? | Mostly **no**. The lag comes from the pre-render storm, the per-render SQL, the global command queue and per-token rendering. All four are fixable in TypeScript. |
| Will Rust fix the memory use? | Mostly **no**. The memory is in Claude Code processes, dev servers, shells, Next.js and Postgres. Rust saves ~0.2–0.5 GB of the API's share. |
| Can 4 vCPU / 8 GB host 50 users? | **Yes for 50 connected or native-agent users** after Phase 1 and 2. **No for 50 simultaneous Claude Code turns with dev servers** in any language: cap and queue them (~6–8 at once), or add RAM or machines. |
| Is Rust compatible with Dokploy + Dockerfile? | **Yes.** It is one extra build stage and one s6 service. Build in CI to keep compiles off the VPS. |
| Is a full rewrite worth it? | **Not now.** ~33k lines, 4–8 months, high risk, small gain for this workload. |
| When would Rust be worth it? | When Phase 3's checklist is met. Then as a narrow edge daemon, not a rewrite. |

---

## Appendix A: measurements already in the repo

From `apps/web/e2e/results/` (Playwright, production build, 2026-10-18):

| Metric | Baseline | After B-series |
|---|---|---|
| First load (ms) | 582 | 435 |
| p95 paint per navigation (ms) | 46 | 66 |
| p95 content per navigation (ms) | 400 | 394 |
| First-load JS per app route (kB) | 315–415 | – |

These are single-user client timings. They show navigation is already fast for one user, which points at **load under concurrency**, not raw code speed, as the problem, and that is what Phase 0's script measures.

## Appendix B: file reference index

| Topic | Files |
|---|---|
| Warmup / prefetch | `apps/web/src/lib/warmup.ts`, `lib/preload.ts`, `components/route-warmup.tsx`, `components/boot-gate.tsx` |
| Realtime → refresh | `apps/web/src/lib/realtime.tsx`, `lib/realtime-cache.ts`, `lib/client.ts` |
| Chat rendering | `apps/web/src/components/project-chat.tsx`, `components/markdown.tsx` |
| Bootstrap query | `apps/server/src/index.ts` (`/api/bootstrap`), `apps/server/src/workspaces.ts` (`listProjects`) |
| Command queue | `apps/server/src/engine.ts`, `worker.ts`, `decide.ts` |
| WebSocket / bus | `apps/server/src/ws.ts`, `bus.ts`, `eventstore.ts` |
| Agent / CLIs | `apps/server/src/agent.ts`, `config.ts`, `packages/agent/src/loop.ts`, `packages/providers/src/{claude,codex,process}.ts` |
| Terminals / git | `apps/server/src/terminals.ts`, `git.ts`, `git-exec.ts`, `apps/web/src/components/git/use-git-state.ts` |
| Proxying | `apps/server/src/web-proxy.ts`, `preview.ts` |
| Deployment | `Dockerfile`, `docker-compose.yml`, `deploy/s6/s6-rc.d/*/run` |
| Crypto contracts | `apps/server/src/password.ts`, `crypto.ts` |
