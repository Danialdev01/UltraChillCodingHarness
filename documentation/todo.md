# UCCH: agent task list

**Why:** [`plan.md`](./plan.md) · **Design:** [`solution.md`](./solution.md) · This file is *what to do*, in order.

Completed tasks from the previous list (P0, S1–S4, D1–D10, B1–B7, B9, B10, B12, R1–R4, R6, R7) have been removed. They are in git history (`git show HEAD:documentation/todo.md`). The tasks that were still open are folded in below: B13 → PF0.8, B8 → PF1.17, the zod part of B11 → PF1.18, R5's `worktreeId` → PF1.24. The rest of R5 and B11, plus R8–R12 and W1–W5, are kept as they were.

## How to use this file (read first)

1. **Pick a task.** Take the lowest-numbered unchecked task in the earliest phase whose **Depends** are all checked. Don't start a task whose dependencies are open. Within PF1, follow the **suggested order** below unless dependencies say otherwise.
2. **Read before writing.** Read every file under **Files**, and the `solution.md` section the task cites. Many tasks reuse existing code; the task names it.
3. **Stay in scope.** One task is one coherent change. Don't refactor neighbouring code, rename unrelated things or reformat files.
4. **Follow the conventions:**
   - `apps/web/CLAUDE.md`: skeletons not spinners, `TransitionLink` / `useTransitionRouter` only, layouts await nothing, a `loading.tsx` per route. (PF1.4 rewrites its "whole app loads at boot" rule.)
   - Match the surrounding code's comment density and naming. Server modules use `#private` fields and explanatory block comments.
   - Tests sit next to the code (`*.test.ts`) and run with vitest from the repo root.
5. **Measure.** Every PF1 task names an **Acceptance** metric. Record before and after numbers in the commit message, measured with the PF0 load script (`scripts/load/run.mjs`) or the counter the task names.
6. **Verify.** Run every command under **Verify**. A task is done only when they all pass *and* every **Acceptance** bullet holds.
7. **Record it.** Change `[ ]` to `[x]` and add ` — <commit sha>` after the title. Commit messages end with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
8. **If blocked:** leave the task unchecked and add a `> BLOCKED:` line under it saying why. Then move to another task with no dependency on it.

Standard verification, for any task that touches code:

```bash
pnpm typecheck && pnpm test
# web tasks also need a production build — next dev does not prefetch
pnpm --filter @ucch/web build
```

Load verification, for any task with a load **Acceptance** (PF0.7 must be done first):

```bash
docker compose build && docker run --rm --cpus=4 --memory=8g … # see scripts/load/README.md
node scripts/load/run.mjs --users 50 --minutes 10 --out documentation/perf/<task>-<date>.json
```

---

## Phase PF0: Measure

Nothing in PF1 starts until PF0.9 has recorded a baseline. **Design:** `solution.md` §1.

- [x] **PF0.1 — Metrics registry and `/metrics`** — 42b3e3b

  - **Depends:** —
  - **Files:** new `apps/server/src/metrics.ts` and `metrics.test.ts`, `apps/server/src/index.ts` (route, fastify `onResponse` hook, near `/health` at line 677), `apps/server/src/config.ts` (`METRICS_TOKEN`), `apps/server/src/engine.ts` (`#process` timings), `apps/server/src/ws.ts` (`sendRaw`, `sendPush`, `#onMessage` counters), `apps/server/src/worker.ts` (`outstanding`)
  - **Steps:**
    1. Write a tiny registry: counter, gauge and histogram with fixed buckets, rendered in Prometheus text format. No new dependency.
    2. Event loop: `monitorEventLoopDelay({ resolution: 10 })` (p50/p99/max, reset per scrape, plus a 60 s rolling window) and `performance.eventLoopUtilization()` deltas.
    3. Process: `process.memoryUsage()`, plus a GC pause histogram by kind (`PerformanceObserver` on `gc`).
    4. Engine: queue depth, plus wait and process histograms by command type.
    5. WebSocket: connections, subscriptions by topic kind, frames and bytes out by frame kind and event type, frames in by kind.
    6. Bus publishes by event type (a `bus.tap`). Gauges for `agentTurns.activeTurns`, `terminals.openTerminals`, `fileWatcher.watchedProjects`, and the clone and worktree worker depths.
    7. An HTTP histogram labelled with `routeOptions.url`. `pg_connections{state}` from `pg_stat_activity` at scrape time.
    8. Access: with `METRICS_TOKEN` set, require a bearer token compared with `timingSafeEqual`. Otherwise allow only when `request.socket.remoteAddress` is `127.0.0.1` or `::1`.
  - **Acceptance:** `curl localhost:3000/metrics` inside the container returns all families. A request from outside the container gets 403 without the token.
  - **Verify:** `pnpm test -- metrics`, plus a curl from inside and outside the container

- [x] **PF0.2 — Resource sampler** — 8af56d3

  - **Depends:** PF0.1
  - **Files:** new `apps/server/src/resource-sampler.ts` and `resource-sampler.test.ts`, `apps/server/src/index.ts`, `apps/server/src/config.ts` (`LOG_RESOURCE_SAMPLES`)
  - **Steps:**
    1. Every 15 s, read `/proc/*/stat` and `/proc/*/statm` for up to 2,000 PIDs.
    2. Group by service: `postgres`, `web` (`node server.js`), `server` (`server.mjs`), `mysqld`. Group the server's descendants by class: `claude`, `codex`, `shell`, `git`, `rg`, `python`, `soffice`, `chromium`, `other`.
    3. Postgres: report `sum(rss − shared)` plus `shared_buffers` (statm field 3).
    4. Read the cgroup files: `/sys/fs/cgroup/memory.current`, `memory.max`, `memory.stat`, `memory.events`.
    5. Export gauges `resource_rss_bytes{group}`, `resource_cpu_seconds_total{group}`, `cgroup_memory_bytes`, `cgroup_oom_kills_total`. With `LOG_RESOURCE_SAMPLES=true`, also log one line per sample.
  - **Acceptance:** `/metrics` shows per-group RSS that adds up to within 10% of `docker stats` for the container.
  - **Verify:** `pnpm test -- resource-sampler`, plus a comparison against `docker stats`

- [x] **PF0.3 — `pg_stat_statements` and slow-query log** — b872740

  - **Depends:** —
  - **Files:** `deploy/s6/s6-rc.d/postgres/run`, new `scripts/pg-top.sh`, `README.md` ("Scaling")
  - **Steps:**
    1. Add `-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top -c pg_stat_statements.max=5000 -c track_io_timing=on -c log_min_duration_statement=${PG_LOG_MIN_DURATION_MS:-500}`.
    2. In the readiness subshell, once Postgres answers, run as `postgres` (idempotent): `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` in `ucch`, and `GRANT pg_read_all_stats TO ucch`.
    3. `scripts/pg-top.sh [--reset]`: the top 20 statements by `total_exec_time` and by `calls`, via `docker exec … psql`.
    4. README: the manual steps when `DATABASE_URL` points at an external server.
  - **Acceptance:** `scripts/pg-top.sh` prints statements after a few page loads, and survives a container restart.
  - **Verify:** `bash scripts/smoke-container.sh`, then `bash scripts/pg-top.sh`

- [x] **PF0.4 — Proxy and bootstrap counters** — 896f9cc

  - **Depends:** PF0.1
  - **Files:** `apps/server/src/web-proxy.ts`, `apps/server/src/index.ts` (`/api/bootstrap`, line 708)
  - **Steps:**
    1. Count proxied requests by class: `document`, `rsc` (header `rsc: 1`), `rsc_prefetch` (`next-router-prefetch: 1`), `static`. Add an upstream-latency histogram.
    2. Count `/api/bootstrap` calls by caller: loopback (SSR) vs browser.
  - **Acceptance:** after one fresh sign-in, `/metrics` shows the number of RSC requests it caused (expected ~117 today).
  - **Verify:** `pnpm typecheck`, plus a manual sign-in against a production build

- [x] **PF0.5 — Load fixtures: mock LLM and fake CLI** — 05c0e9a

  - **Depends:** —
  - **Files:** `apps/server/src/config.ts` (`OPENROUTER_BASE_URL`), `apps/server/src/openrouter.ts` (constant at line 18), new `scripts/load/mock-openrouter.mjs`, new `scripts/load/fake-claude.mjs`, new `scripts/load/README.md`
  - **Steps:**
    1. `OPENROUTER_BASE_URL` defaults to today's constant and replaces `BASE` everywhere in `openrouter.ts`.
    2. `mock-openrouter.mjs`: SSE `/chat/completions` with `--rate` (tokens/s), `--chunk` (tokens per event) and `--length`. Also serve the model-catalogue endpoints `contextLengthFor` and `supportsImages` read.
    3. `fake-claude.mjs`: replay stream-json fixtures (copied from `packages/providers/src/claude.test.ts`) at a configurable rate. `--rss-mb N` allocates and holds N MB.
    4. The README explains how to point a container at both (`OPENROUTER_BASE_URL`, `CLAUDE_BIN`).
  - **Acceptance:** a native turn and a Claude Code turn both complete against the mocks without network access.
  - **Verify:** `pnpm test`, plus a manual turn of each kind

- [x] **PF0.6 — Load-test seeding** — 3314cc7

  - **Depends:** —
  - **Files:** new `apps/server/scripts/seed-load.ts`, `apps/server/src/password.ts`, `apps/server/src/crypto.ts`, `apps/server/src/auth.ts` (`createSession`), `apps/server/src/workspaces.ts` (`ensureDefault`)
  - **Steps:**
    1. Refuse to run unless `LOADTEST_ALLOW_SEED=1` is set and the database name ends in `_load`.
    2. Create N users (`--users`) with real password hashes and an encrypted dummy OpenRouter key.
    3. One shared workspace with every user as a member, plus each user's personal workspace.
    4. Sessions via `createSession`, not `/api/auth/login`, which allows 20/min (`index.ts:3104`). Write `{ userId, cookie }[]` to `$LOAD_OUT/sessions.json`.
    5. P projects per workspace (`--projects`) through a real WebSocket `project.create`, so the clone reactor runs.
  - **Acceptance:** `--users 50 --projects 20` finishes in under a minute, and every cookie authenticates `GET /api/me`.
  - **Verify:** run it against a `ucch_load` database

- [x] **PF0.7 — Load generator** — 49f47e9

  - **Depends:** PF0.1, PF0.5, PF0.6
  - **Files:** new `scripts/load/run.mjs` (reusing the frame helpers in `scripts/smoke-phase1.mjs`), `scripts/load/README.md`, new `apps/web/e2e/stream.spec.ts`
  - **Steps:**
    1. Per virtual user:
       - ws-ticket, then `/ws`;
       - subscribe to `user`, `workspace`, and a quiet `project` topic for each listed project;
       - every 30 s, `GET /api/bootstrap`, one document and 5 RSC prefetches through :3000;
       - keep a `thread` subscription with replay.
    2. The mix:
       - 20% send a native turn every 60 s (1,500 tokens at 60 tokens/s);
       - 30% type 5 chars/s in a terminal;
       - 30% fetch git status, branches and log every 60 s, as `use-git-state.ts` does.
    3. Histograms:
       - ack RTT by command;
       - keystroke echo (send until the `terminal.output` containing the character);
       - frames and bytes per turn;
       - bootstrap latency and document TTFB.
    4. Scrape `/metrics` every 5 s. Write one JSON result file plus a Markdown summary.
    5. `stream.spec.ts`: open a chat, send a message to the mock, and record long tasks (`PerformanceObserver('longtask')`), INP and frame-to-paint while it streams.
  - **Acceptance:** a 10-minute 50-user run against `docker run --cpus=4 --memory=8g` completes and writes the result file.
  - **Verify:** the load verification block above

- [x] **PF0.8 — Real-user web vitals** *(was B13)* — bf263c4

  - **Depends:** PF0.1
  - **Files:** new `apps/web/src/components/vitals-reporter.tsx` (`web-vitals`), `apps/web/src/lib/view-transitions.tsx` (nav marks in `TransitionLink`, line 145), `apps/web/src/components/terminal-view.tsx` (echo mark), `apps/server/src/index.ts` (`POST /api/metrics/vitals`), `apps/server/src/metrics.ts`
  - **Steps:**
    1. Report LCP, INP, CLS and TTFB, plus `nav-skeleton`, `nav-content`, `frame-to-paint` and `keystroke-to-echo`, via `navigator.sendBeacon`. Batch them, with configurable sampling (default 100%).
    2. The server rate-limits the endpoint and aggregates into `/metrics` histograms by route template. **No table, no migration, nothing personal stored.**
  - **Acceptance:** histograms fill after navigating around, and nothing is written to the database.
  - **Verify:** `pnpm test`, plus a curl of `/metrics`

- [x] **PF0.9 — Baseline and `plan.md` corrections** — c4247c5

  - **Depends:** PF0.2, PF0.3, PF0.4, PF0.7, PF0.8
  - **Files:** new `documentation/perf/baseline-<date>.json` and `documentation/perf/README.md`, `documentation/plan.md`
  - **Steps:**
    1. Run the 50-user load for 10 minutes against the production image, with `stream.spec.ts` and `perf.spec.ts` running alongside.
    2. Record:
       - CPU and RSS per service and per child class;
       - event-loop p99 and utilisation;
       - the top 10 statements (`pg-top.sh`);
       - RSC requests for one fresh login;
       - keystroke echo p95, token-to-paint p95, nav-skeleton p95;
       - frames per turn, and peak concurrent `claude` processes.
    3. Fill the "Baseline" column of the Definition of Done table below.
    4. In `plan.md`, replace each *est.* value with its measured value where one exists.
  - **Acceptance:** every Definition of Done row has a baseline number.
  - **Verify:** review the file

---

## Phase PF1: Fix the architecture

**Design:** `solution.md` §2–§12.

**Suggested order by impact** (dependencies permitting):
1. PF1.3 → PF1.4 → PF1.5 → PF1.7 (warmup and herds)
2. PF1.8 (bootstrap)
3. PF1.26 (subscriptions)
4. PF1.10 (terminals)
5. PF1.1 → PF1.2 → PF1.11 (correctness, then a parallel engine)
6. PF1.13 → PF1.14 → PF1.15 → PF1.16 → PF1.17 (streaming)
7. PF1.20 (caps)
8. PF1.23 → PF1.24 → PF1.25 (git)
9. The rest.

PF1.1 and PF1.2 fix existing bugs and may run during PF0.

### Correctness first

- [x] **PF1.1 — Stream lock and unique project-scoped sequence numbers** — 00fc4e9

  - **Depends:** —
  - **Files:** `apps/server/src/eventstore.ts` (`append`, `nextSeq` at lines 42–76 and 181–192), `packages/db/src/schema.ts` (`events_project_seq_idx`, line 381), new migration `packages/db/migrations/0025_event_stream_seq.sql`, new `apps/server/src/eventstore.test.ts` (with a recording `tx` double, as in `engine.test.ts`)
  - **Steps:**
    1. In `append`'s transaction, before `nextSeq`, run `select pg_advisory_xact_lock(hashtextextended($1, 0))` with key `thread:<id>` or `project:<id>`. **It must be a separate statement:** under READ COMMITTED a `max(seq)` in the same statement could read pre-lock data.
    2. Change `schema.ts` to `uniqueIndex("events_project_seq_idx").on(projectId, seq).where(sql\`thread_id is null\`)`. Run `pnpm db:generate`, then append the renumbering `UPDATE` (`solution.md` §2.1) before the index statements.
    3. Leave transient-only appends untouched; they skip the transaction.
  - **Acceptance:** the migration runs on a copy of a real database. Concurrent project-scoped appends never produce a duplicate `(project_id, seq)`.
  - **Verify:** `pnpm test -- eventstore`, plus `pnpm db:migrate` against a copy
  - **Measured:**
    - The migration is `0026_event_stream_seq.sql`: PF1.8 took 0025.
    - On a copy of the development database with 3 duplicates planted, the migration renumbered those 3 streams and left the rest alone.
    - 200 concurrent appends to one project: 0 failures and 0 duplicates with the lock; 178 unique-index failures without it.

- [x] **PF1.2 — A send claims the thread (`queued`), and `turn.dequeued`** — abc4ddd

  - **Depends:** —
  - **Files:** `apps/server/src/engine.ts` (`applyProjection`, the `user.message` case), `apps/server/src/decide.ts` (`thread.send`, `thread.cancel`), `apps/server/src/agent.ts` (`#run` early returns, lines 340–355), `apps/server/src/index.ts` (boot reset, line 130), `packages/protocol/src/events.ts` (`turn.dequeued`), `packages/protocol` `ThreadSnapshot.status`, `apps/web/src/components/project-sessions-nav.tsx` (lines 78, 126), `apps/web/src/lib/chat-messages.ts`
  - **Steps:**
    1. Projection of `user.message`: `update threads set status = 'queued' where id = $1 and status in ('idle','error')`. On 0 rows, throw a conflict that the engine maps to `{ code: "conflict" }`.
    2. `decide`: `thread.send` is rejected while `queued`, and `thread.cancel` is accepted while `running` or `queued`.
    3. New durable event `turn.dequeued { reason: "error" | "cancelled" | "restart" }`, projected as `status = 'idle'`. Every early return in `#run` appends it.
    4. Boot reset: `queued` threads get `turn.dequeued { reason: "restart" }` through `store.append` + `applyProjection`.
    5. Web: `queued` counts as working. `toMessages` renders a dequeued turn as "Stopped before it started".
  - **Acceptance:** two `thread.send` frames 1 ms apart start exactly one turn, and the second gets `conflict`. No thread stays `queued` after a restart.
  - **Verify:** `pnpm test -- engine decide chat-messages`
  - **Measured:**
    - Two sends 1 ms apart on the load target: 2 turns before, 1 turn and a `conflict` after.
    - A thread left `queued` is `idle` after a restart, with `turn.dequeued { reason: "restart" }` in its log.

### Warmup, boot and refresh (`solution.md` §3–§4)

- [x] **PF1.3 — Shrink the warmup and remove re-warm triggers** — 21cb70b

  - **Depends:** PF0.9
  - **Files:** `apps/web/src/lib/warmup.ts` (`BUDGET` line 58, `warmupPlan` line 111), `apps/web/src/lib/preload.ts` (FULL prefetch line 228, `forgetPrefetched`/`onForgotten`/`warmedAt`), `apps/web/src/components/route-warmup.tsx` (triggers at lines 84–99), `apps/web/src/lib/realtime.tsx` (line 287), `apps/web/src/lib/warmup.test.ts`, `apps/web/src/lib/preload.test.ts`
  - **Steps:**
    1. `BUDGET = { projects: 3, sessionLists: 20, fileTrees: 1, hot: 0 }`.
    2. `warmupPlan` returns data queries and session lists only. No route gets `kind: FULL` except the page about to open. Viewport prefetch from `TransitionLink` (default kind, to `loading.tsx`) stays untouched.
    3. Keep the idle import of `CHUNKS`.
    4. Delete the visibility re-warm, the hot interval and the `onForgotten` re-warm in `route-warmup.tsx`. Delete `forgetPrefetched`, `onForgotten` and `warmedAt` in `preload.ts`, and the call in `realtime.tsx`.
    5. Add hover-intent data prefetch on project links: `onPointerEnter` → `queryClient.prefetchQuery` for that project's lists.
  - **Acceptance:**
    - RSC requests for one fresh sign-in (PF0.4 counter) ≤ 15, down from ~117.
    - 0 RSC requests in other tabs when a member saves settings.
    - `perf.spec.ts` nav-skeleton p95 is unchanged (≤ 100 ms).
  - **Verify:** standard, plus `pnpm --filter @ucch/web e2e`
  - **Measured:**
    - Sign-in: 1 RSC render, plus 18 viewport prefetches to `loading.tsx`, which call no bootstrap. That is 19 counting both, against the ≤ 15 target.
    - Settings save: 1 RSC per other tab, the bridge's `router.refresh()`, which PF1.5 removes.
    - Nav-skeleton p95: 74 ms under load.

- [x] **PF1.4 — Remove the boot gate and rewrite the CLAUDE.md rule** — 4d4357f

  - **Depends:** PF1.3
  - **Files:** `apps/web/src/components/boot-gate.tsx` (delete), `apps/web/src/lib/boot-cookie.ts` (delete), `apps/web/src/lib/boot-progress.ts` (delete if unused), `apps/web/src/app/(app)/layout.tsx` (line 27), `apps/web/src/components/app-shell.tsx` (`booted` prop), `apps/web/src/components/boot-screen.tsx`, `apps/web/src/components/boot-frame.tsx` (keep if `login-form.tsx` still uses it), `apps/web/src/components/nav-user.tsx` (`forgetWarm`), `apps/web/CLAUDE.md` (the "whole app loads at boot" section)
  - **Steps:**
    1. Delete the gate, the `ucch_warm` cookie and every reader.
    2. `boot-screen.tsx` becomes a plain transition to the destination after sign-in, with no wait on preload.
    3. Rewrite the CLAUDE.md rule: "Every click paints a skeleton in the same frame (viewport prefetch to `loading.tsx`). Content is instant for the recent projects whose data the persisted cache holds; others show their skeleton until their data arrives. Never pre-render pages in the background."
  - **Acceptance:** the first page of a new browser session shows the shell skeleton immediately with no progress overlay. Sign-in → interactive shell ≤ 2.0 s.
  - **Verify:** standard, plus `pnpm --filter @ucch/web e2e`

- [x] **PF1.5 — CacheBridge without refresh; `ProjectSeed` / `useProject`** — 38c9630

  - **Depends:** PF1.3
  - **Files:** `apps/web/src/lib/realtime.tsx` (CacheBridge, lines 272–311), `apps/web/src/lib/realtime-cache.ts` (`cacheEffect`, `RESOURCES`), `apps/web/src/lib/query-keys.ts`, new `apps/web/src/lib/queries/project.ts` (`ProjectSeed`, `useProject`), project page consumers and `components/project-chat.tsx`, `components/app-sidebar.tsx` and the `ViewerProvider` (read `useBootstrap().data.me`), `components/section-panel.tsx` (line 112), `apps/web/src/lib/realtime-cache.test.ts`
  - **Steps:**
    1. Remove `refreshPage` from `cacheEffect`, and the `router.refresh()` from the bridge.
    2. `account_settings` invalidates `[bootstrap]`. `project_settings` invalidates `[tasks, bootstrap, project.all]`.
    3. Add `qk.project(hash)`, a `ProjectSeed` that seeds from the RSC prop the way `BootstrapSeed` does, and `useProject(hash)`. Move the project page's consumers onto it.
    4. Sidebar user and viewer name come from `useBootstrap().data.me`.
    5. `section-panel.tsx:112`: invalidate `[bootstrap]` instead of refreshing.
    6. Test: a grep assertion that `lib/realtime*.tsx` contains no `router.refresh`.
  - **Acceptance:** 0 page refreshes caused by realtime events. A rename, profile change or preview-port change in one tab shows in another without a refresh.
  - **Verify:** standard, plus a manual two-browser check

- [x] **PF1.6 — Convert local `router.refresh()` call sites** — 8d01569

  - **Depends:** PF1.5
  - **Files:** the call sites in `solution.md` §4's table, e.g. `lib/use-new-session.ts:31`, `components/new-project-dialog.tsx:365`, `components/session-list.tsx:53`, `components/file-explorer-toggle.tsx:143,153`, `components/project-chat.tsx:817`, `components/preview-dialog.tsx:118`, `components/account-settings.tsx:52`, `components/workspace-switcher.tsx:97,335,349`, `components/invite-accept.tsx:33`, the three database dialogs, `components/nav-user.tsx:58`
  - **Steps:**
    1. Apply the table: delete, invalidate, or keep.
    2. Logout uses `window.location.replace("/login")`.
    3. Keep `lib/workspace-context.tsx:58` and `components/workspace-members-settings.tsx:307`.
  - **Acceptance:** `grep -rn "router.refresh" apps/web/src` lists only the kept sites (plus `tables-column.tsx` if its grid isn't query-backed), and each converted flow updates the UI without a refresh.
  - **Verify:** standard, plus a manual pass over each converted flow
  - **Measured:** (headless Chrome on the load image, non-prefetch RSC requests during each flow)
    - The grep lists the two kept sites, `tables-column.tsx` (its grid reads rows outside the query cache) and the `view-transitions.tsx` wrapper. `navigation.test.ts` fails on any other.
    - 0 RSC requests: account name → sidebar; connection settings → its page, the header and the sidebar; session rename → header, sidebar and files panel; preview port → header; session delete; workspace rename → switcher.
    - 1 RSC request, for the page the flow opens: new session, connection remove. Logout is one full load of `/login`.
    - Not driven: new connection, workspace archive and delete, invite accept. They use the same invalidations as the flows above.
    - Two props the old refresh used to re-render were stale without it. The connection page now reads its connection from bootstrap. The files panel takes a newer copy of the page's project, so the session menu's Rename and Delete name the session as it is after a rename.

- [x] **PF1.7 — Smooth the bootstrap herd from turn edges** — 09a321f

  - **Depends:** PF1.5
  - **Files:** `apps/web/src/lib/realtime.tsx` (CacheBridge), `apps/web/src/lib/realtime-cache.ts`, `apps/web/src/lib/realtime-cache.test.ts`
  - **Steps:**
    1. Bootstrap invalidations caused by `thread.created`, `agent.turn_completed` and `agent.turn_failed` use a trailing debounce of 3 s plus 0–2 s jitter.
    2. `refetchType: document.hidden ? "none" : "active"`.
  - **Acceptance:** under the load script, at most one bootstrap request per visible tab per 3 s from turn edges (PF0.4 counter).
  - **Verify:** `pnpm test -- realtime-cache`, plus load

### Bootstrap (`solution.md` §5)

- [x] **PF1.8 — `project_stats` projection** — d38bd1a

  - **Depends:** —
  - **Files:** `packages/db/src/schema.ts`, new migration `0026_project_stats.sql` (table, backfill, `threads_running_idx`), `apps/server/src/engine.ts` (`applyProjection`, line 245), `apps/server/src/workspaces.ts` (`listProjects`, line 374), `apps/server/src/index.ts` (thread delete, line 1596), `apps/server/src/engine.test.ts`
  - **Steps:**
    1. Create the table and the partial index, and backfill per project with today's subqueries (`solution.md` §5). The failed predicate uses `LIMIT_STOP_REASONS` (`packages/protocol/src/events.ts:409`).
    2. Projection, relative SQL only:
       - `project.created`: insert the row;
       - `thread.created`: `+1`;
       - `turn.started`: set `last_turn_id`, clear the failed flag;
       - `agent.turn_completed`: add tokens and cost, then set the failed flag;
       - `agent.turn_failed`: set the failed flag.
    3. The thread delete runs in a transaction with `recomputeProjectStats(tx, projectId)`.
    4. `listProjects` joins `project_stats` (coalesce to 0), and `running` uses an `EXISTS` on `threads_running_idx`.
  - **Acceptance:**
    - With 200 projects and 20,000 turns, bootstrap server p95 < 15 ms.
    - `EXPLAIN` shows no scan of `turns`.
    - Not in the top 5 of `pg-top.sh`.
  - **Verify:** `pnpm test -- engine workspaces`, plus `pnpm db:migrate` on a copy and the counts compared with the old query
  - **Measured:**
    - The migration is `0025_project_stats.sql`: PF1.1's migration is not written yet.
    - Bootstrap server p95: 74 ms → 5.3–5.9 ms. `EXPLAIN` shows no scan of `turns`.
    - Backfill on a copy matched the old query for all 1,220 projects. No drift after a 4-minute load run.
    - pg-top: `listProjects` mean 1.52 → 0.21 ms, but it is still #1 by total time. The cost is at its floor; the call count keeps it there, so the top-5 criterion is not met.

- [x] **PF1.9 — Trim `/api/bootstrap`** — 2613a21

  - **Depends:** —
  - **Files:** `apps/server/src/index.ts` (lines 708–752), `apps/server/src/workspaces.ts` (`ensureDefault`, `listProjects`), `apps/server/src/auth.ts` (`getProfile`, `hasPassword`)
  - **Steps:**
    1. `ensureDefault` takes the already-fetched list, and creates and re-lists only when needed, so `list()` runs once.
    2. Combine `getProfile` and `hasPassword` into one select.
    3. `listProjects` accepts a checked permission and skips its `canView`.
    4. No early ETag (`solution.md` §5 explains why).
  - **Acceptance:** bootstrap issues ≤ 4 queries (a query counter in a test, or `pg_stat_statements` `calls`).
  - **Verify:** standard, plus `curl /api/bootstrap` (the shape is unchanged; the 304 still works)
  - **Measured:** (`pg_stat_statements` calls for 100 bootstraps of one load user, the session cached)
    - Queries per bootstrap: 7 → 4 (workspaces, the user row, projects, connections).
    - `/api/bootstrap` and `/api/me` answer byte-identical bodies before and after, and `If-None-Match` still gets a 304.
    - A user with no workspace gets "Personal", created once and listed in the same response.
    - `listProjects` takes `isMember` (the membership `list` already showed) rather than a permission: `canView` checks membership, not `workspace.view`.

### Command path (`solution.md` §6)

- [x] **PF1.10 — Terminal fast path** — 7614e2a

  - **Depends:** —
  - **Files:** `packages/protocol` (rpc.ts `ClientFrame`: `terminal_input`, `terminal_resize`), `apps/server/src/ws.ts` (`#onMessage`, line 157; zod parse at line 177), `apps/server/src/terminals.ts` (new `input`/`resize`, early-input buffer, `#open`), `apps/web/src/lib/client.ts` (`terminalInput`, `terminalResize`), `apps/web/src/components/terminal-view.tsx` (lines 199, 212), `apps/web/src/components/login-terminal-dialog.tsx` (lines 142, 148), `apps/server/src/terminals.test.ts`
  - **Steps:**
    1. `ws.ts` recognises the two frame kinds before zod (a raw prefix test, then `typeof` and length ≤ 64 KB checks). It checks the `exec` scope, then calls `terminals.input()` / `resize()`. No ack, no `onDispatched`; at most one rate-limited `error` on refusal.
    2. Keep accepting `dispatch terminal.*`.
    3. `TerminalReactor`: an early-input buffer for terminals not yet open, accepted only from the claim holder (`mayWatch`, line 170), capped at 64 KB and 30 s, and flushed in `#open` with the last size applied.
    4. The client methods are fire-and-forget, with no pending promise.
  - **Acceptance:** under 50-user load with turns streaming, keystroke echo p95 < 30 ms and p99 < 60 ms, with 0 ack frames for terminal input.
  - **Verify:** `pnpm test -- terminals ws`, plus load
  - **Measured:**
    - Keystroke echo p95/p99: 1.82/4.21 ms, against 2.61/5.81 ms for the old dispatch path on the same image (`run.mjs --type-via dispatch`).
    - 0 ack frames for 18,212 `terminal_input` frames in a 4-minute run.

- [x] **PF1.11 — Keyed engine queue** — 71c2b47

  - **Depends:** PF1.1, PF1.2
  - **Files:** `apps/server/src/worker.ts` (new `KeyedWorker`), `apps/server/src/engine.ts` (lines 39–75), `apps/server/src/ws.ts` (per-connection ordering chain), `apps/server/src/access.ts` (`projectOfThread`), `apps/server/src/config.ts` (`ENGINE_MAX_PARALLEL`), `apps/server/src/index.ts` (shutdown, line 3324), `apps/server/src/worker.test.ts`
  - **Steps:**
    1. `KeyedWorker<T>`: a `DrainableWorker` per key, created lazily and deleted when idle, behind a semaphore of `ENGINE_MAX_PARALLEL` (default 8). It exposes aggregate `outstanding`, `drain()` and `stop()`.
    2. Keys:
       - `p:<projectId>` when the command carries one;
       - for a `threadId`, `p:<projectOfThread>`, falling back to `t:<threadId>`;
       - `w:<workspaceId>` for `project.create`;
       - `preview:<hash>` for `preview.delete`.
    3. In `ws.ts`, each connection chains key resolution: `conn.order = conn.order.then(resolveKey).then(push)`.
    4. `loadConfig` rejects `ENGINE_MAX_PARALLEL > DB_POOL_MAX − 4` once PF1.27 lands.
  - **Acceptance:** engine wait p99 < 20 ms under load. Commands from one connection run in the order sent.
  - **Verify:** `pnpm test -- worker engine`, plus load
  - **Measured:**
    - Engine wait p50/p99 under the PF0 load (50 users, 5 min): 0.51 / 6.05 ms before, 0.50 / 0.99 ms after.
    - Commands from one socket whose key lookups finish out of order reach the engine in the order sent (`ws.test.ts`).
    - `ENGINE_MAX_PARALLEL` is clamped to `DB_POOL_MAX − 4` in `index.ts` (6 today); the `loadConfig` check waits for PF1.27.

- [ ] **PF1.12 — One join in `#loadState`** *(optional)*

  - **Depends:** PF1.11
  - **Files:** `apps/server/src/engine.ts` (lines 129–220)
  - **Steps:** Fetch thread → project → workspace + membership in one query when the command carries a `threadId` or `projectId`. Keep the `turnId` read separate.
  - **Acceptance:** engine process time p50 for `thread.send` drops by ≥ 30%.
  - **Verify:** `pnpm test -- engine`, plus load
  > BLOCKED: the join cannot meet the acceptance, so it was not merged. Written and tested (one left-joined read from `(select 1)`, a command's own ids first), then measured in the load container: the state read for a `thread.send` took 0.144 → 0.086 ms p50 (0.78 → 0.41 ms p99) over 2,000 alternating rounds. `thread.send` process time is about 11 ms under load (mean, 135 sends), so the saving is about 0.5%. The three reads were never the cost. The time is in the append, so a 30% cut has to come from there.

### Streaming and chat (`solution.md` §7–§8)

- [x] **PF1.13 — Delta coalescer, and deltas on the thread topic only** — 07d3ede

  - **Depends:** —
  - **Files:** new `apps/server/src/delta-coalescer.ts` and `delta-coalescer.test.ts`, `apps/server/src/agent.ts` (the `append` closure at line 364), `apps/server/src/bus.ts` (topic routing, line 90), `apps/server/src/config.ts` (`STREAM_FLUSH_MS`)
  - **Steps:**
    1. `push(delta)` merges runs of the same type and `turnId`. A turn's first delta is published immediately. Then a 40 ms trailing flush, or an immediate flush at 2,048 buffered characters.
    2. Any non-delta batch calls `flush()` before `store.append`. `finally` flushes and clears the timer.
    3. `bus.ts`: `agent.text_delta` and `agent.thinking_delta` go to `thread:` only.
  - **Acceptance:** a 2,000-token answer at 60 tokens/s sends ≤ ⅓ of today's frames, and time-to-first-token is unchanged.
  - **Verify:** `pnpm test -- delta-coalescer`, plus load (frames per turn)
  - **Measured:**
    - Delta frames per turn under the PF0 load (1,500 deltas at ~60 a second): 1,500 before, 501 after. That is a third plus the turn's first delta, which is never held, so one frame over a strict third.
    - Bytes per turn: 453 KB before, 178 KB after.
    - Time to first token p50/p95/p99: 351/378/387 ms before, 348/378/385 ms after.

- [x] **PF1.14 — Client thread store; deltas ephemeral; no zod on hot frames** — d5d5ef1

  - **Depends:** —
  - **Files:** `apps/web/src/lib/client.ts` (`EPHEMERAL` line 20, `#record` lines 386–422, `#emit` line 471, `ServerFrame.parse` line 297), new `apps/web/src/lib/thread-store.ts` and `thread-store.test.ts`, `packages/protocol` (`THREAD_WINDOW = 1000`, `ready.buildId`), `apps/server/src/ws.ts` (`REPLAY_LIMIT` uses `THREAD_WINDOW`; `ready` carries `buildId`)
  - **Steps:**
    1. Add `agent.text_delta` and `agent.thinking_delta` to `EPHEMERAL`.
    2. Batch `#emit` per animation frame, with a 100 ms timer fallback when the tab is hidden.
    3. `parseServerFrame`: `JSON.parse` plus a structural check of `kind`, `subscriptionId` and `event.type`. A dynamically imported zod check runs in development only.
    4. `thread-store.ts`:
       - **durable layer:** sorted by seq, `Set<seq>` dedupe, capped at `THREAD_WINDOW`;
       - **live layer:** `Map<turnId, runs[]>`, cleared by `agent.message`, `agent.turn_completed`, `agent.turn_failed` and `turn.dequeued`;
       - `durableVersion` / `liveVersion` via `useSyncExternalStore`, notified at most once per frame;
       - the live layer is dropped on resync.
    5. On a `ready.buildId` mismatch, show the update prompt (or reload if W5 isn't done).
  - **Acceptance:** a 4,000-token answer never pushes earlier messages out of view. The `ServerFrame.parse` CPU is gone from the streaming profile.
  - **Verify:** `pnpm test -- thread-store client`, plus `pnpm --filter @ucch/web build`
  - **Measured:**
    - `stream.spec.ts` with a 4,000-token answer: the message sent was gone from the screen when the answer finished before, and is still shown after. The spec now records this as `kept`.
    - Frame-to-paint p50/p95/p99: 13.7/16.7/22.4 ms before, 13.8/19.1/21.8 ms after. No long tasks either way.
    - The production bundle has `parseServerFrame` and no schema check.
    - Runs outlive their turn, unlike the plan's live layer: a turn's thinking is never logged, so dropping it at `turn_completed` would have lost it from the screen.
    - `ready.buildId` is inert until a build sets both `BUILD_ID` and `NEXT_PUBLIC_BUILD_ID`.

- [x] **PF1.15 — Chat render: durable/live split, memoized messages, streaming tail** — e21969e

  - **Depends:** PF1.14
  - **Files:** `apps/web/src/components/project-chat.tsx` (filter line 615, worktree line 629, `toMessages` line 646, list line 1239, `Message` line 1872), `apps/web/src/lib/chat-messages.ts` (line 248) and `chat-messages.test.ts`, `apps/web/src/components/markdown.tsx` (line 199), new `StreamingMarkdown`
  - **Steps:**
    1. Split the work into `toMessages(durable)`, memoized on `durableVersion`, and `overlayLive(messages, live)`, which clones only the active turn's message.
    2. Remove the per-delta thread filter. `worktree`, `promptHistory` and `neighbours` depend on durable data only.
    3. Make `Message` a `React.memo`, with a stable per-message ref callback from a registry.
    4. `StreamingMarkdown`: the prefix up to the last blank line outside a code fence goes through the memoized `Markdown`, and only the tail re-parses.
  - **Acceptance:** on a 4,000-token answer, no long task over 50 ms while streaming, and INP < 200 ms (`stream.spec.ts`). `overlayLive` matches today's output on every existing fixture.
  - **Verify:** `pnpm test -- chat-messages`, plus `pnpm --filter @ucch/web e2e`
  - **Measured:** (stream.spec, a 4,000-token answer, CPU throttled 4x)
    - Long tasks while streaming: 1 × 55 ms before; none in 3 of 4 runs after, and 1 × 53 ms in the other.
    - INP: 48 → 32 ms.
    - Frame-to-paint p50/p95/p99: 22.3/31.5/40.7 → 18.0/20.1/32.4 ms (the median run).
    - `overlayLive(fold(durable), live)` equals `fold(rows)` on every fixture.

- [x] **PF1.16 — Batched replay frame** — 34fc959

  - **Depends:** —
  - **Files:** `packages/protocol` (rpc.ts `ServerFrame`: `replay`), `apps/server/src/ws.ts` (subscribe replay, lines 258–319), `apps/server/src/eventstore.ts` (new `readThreadRaw`), `apps/web/src/lib/client.ts` (`caps=replay1` in the socket URL at line 184, batch record + single emit)
  - **Steps:**
    1. `readThreadRaw` selects `payload::text`. Frames are assembled by string concatenation, ≤ 256 KB each.
    2. Between chunks, wait while `bufferedAmount > 1 MB` (5 ms polls). Buffered live events follow, deduped by seq.
    3. Only with `caps=replay1`; otherwise keep the per-event path.
  - **Acceptance:** a 1,000-event replay arrives in ≤ 5 frames, with server p95 < 50 ms.
  - **Verify:** `pnpm test -- ws`, plus load
  - **Measured:** (a 1,000-event thread of 1.85 MB, 220 subscribes during a 50-user load run)
    - Frames per replay: 1,000 → 8. That misses the ≤ 5 target because these events average 1.85 KB, so 256 KB frames hold about 140 each. Five frames needs events of about 1.3 KB or less. The 256 KB cap from solution.md §8 was kept.
    - Subscribe ack p50/p95/p99: 15.95/21.88/23.34 → 12.45/19.98/23.15 ms, under the 50 ms target.
    - Load run: `replay_frames` p95 1,000 → 8, with no errors.

- [x] **PF1.17 — One WebSocket per tab: chat on the shared socket** *(was B8)* — 66a6ecd

  - **Depends:** PF1.13, PF1.14, PF1.16
  - **Files:** `apps/web/src/components/project-chat.tsx` (own client at lines 380–447), `apps/web/src/lib/client.ts` (subscription refcounts, around line 236), `apps/web/src/lib/realtime.tsx` (`useRealtime().subscribe`, `dispatch`), `apps/web/src/lib/create-project.ts`
  - **Steps:**
    1. Reference-count subscriptions per topic. The effective `quiet` is the AND of all holders, and it is re-sent when a holder releases.
    2. `useRealtime()` exposes `subscribe(topic, opts, onEvent)` and `dispatch()`.
    3. The chat reads its thread store from the shared client. Delete its `new UcchClient()`. `create-project.ts` keeps its one-off socket by design.
  - **Acceptance:** DevTools shows one `/ws` per tab after visiting a chat, a terminal and the dashboard, and deltas arrive once.
  - **Verify:** `pnpm test -- client`, plus manual
  - **Measured:** (headless Chrome on the load image)
    - Sockets per tab after a chat, a terminal and the dashboard: 2 → 1. Leaving the project unsubscribes its thread and terminal.
    - stream.spec, a 4,000-token answer: 1,334 deltas, each received once, and the sent message stays on screen.
    - The plan's `useRealtime().subscribe/dispatch` wrappers were not added. Views call `client.hold` and `client.dispatch` on the client `useRealtime()` returns, as the terminals already did.

- [x] **PF1.18 — `@ucch/protocol/plain`: client code without zod** *(the zod part of B11)* — 09cd500

  - **Depends:** PF1.14
  - **Files:** `packages/protocol/package.json` (`exports["./plain"]`, `"sideEffects": false`), new `packages/protocol/src/plain.ts`, web imports of runtime values from `@ucch/protocol` (constants and helpers such as `TASK_STAGES`, `AVATAR_SIZE`, identifier helpers), a new test that forbids runtime imports of the barrel in `apps/web/src`
  - **Steps:**
    1. Move zod-free constants and helpers into `plain.ts`, re-exported from the barrel.
    2. Point web runtime imports at `@ucch/protocol/plain`. Type-only imports stay on the barrel (`import type`).
    3. Run the analyzer to confirm zod is gone from shell chunks.
  - **Acceptance:** shell-route first-load JS drops by roughly the size of zod (~12 kB gz). `bundle-budget.mjs --check` passes.
  - **Verify:** `ANALYZE=1 pnpm --filter @ucch/web build`, plus `node apps/web/scripts/bundle-budget.mjs --check`
  - **Measured:** (`next build`, first-load JS gzipped)
    - The zod chunk (12.6 kB) was on every shell route. Now it is on none: not home, dashboard or session. It stays on the database pages, whose forms validate with `Identifier`, `ColumnSpec`, `CreateDatabaseBody` and `CreateUserBody`, imported from `@ucch/protocol/database`.
    - Shell routes 314–322 → 297–305 kB (−17 kB, zod plus the barrel's schemas). Session 407 → 400 kB, tasks 385 → 364 kB. `/login` unchanged. `--check` is within budget.
    - The enums the web read at runtime became plain arrays the zod enums are built from (`DATABASE_ENGINES`, `PROJECT_MODES`), and `DevDatabaseName.safeParse` became `DEV_DATABASE_NAME.test`.

- [x] **PF1.19 — Bounded `threadHistory`** — 0938a0e

  - **Depends:** —
  - **Files:** `apps/server/src/eventstore.ts` (lines 137–168), `apps/server/src/config.ts` (`HISTORY_CACHE_EVENTS`), `apps/server/src/metrics.ts`
  - **Steps:**
    1. Replace the 32-thread cap with a total-event cap (default 20,000), evicting least-recently-used threads.
    2. A thread larger than half the cap is returned but not cached.
    3. Add a gauge for the cached event count.
  - **Acceptance:** API heap stays flat across 50 different thread opens under load.
  - **Verify:** `pnpm test -- eventstore`, plus load
  - **Measured:** (load image, 50 threads of 2,485 events each, built from two copies of a real 1,245-event thread at about 4.5 MB of JSON, one native turn on each in turn, heap read after a full GC through the inspector)
    - Retained heap before: 60 → 200 MB, +5.2 MB per thread until the 32-thread cap. That ceiling grows with thread length.
    - After: 70.1–70.5 MB, flat from the 10th thread to the 50th. `history_cache_events` holds 17,521 (7 threads) and never exceeds 20,000.
    - Heap sampled without a GC is no guide here. A turn on an evicted thread parses its whole history again, which is more garbage, but none of it is kept.

### Global caps (`solution.md` §9)

- [x] **PF1.20 — Turn scheduler: global caps with a queue** — ac8b9f6

  - **Depends:** PF1.2
  - **Files:** new `apps/server/src/turn-scheduler.ts` and `turn-scheduler.test.ts`, `apps/server/src/agent.ts` (`#run`; remove the throw at lines 653–660), `apps/server/src/config.ts` (`AGENT_MAX_CONCURRENT_TOTAL`, `AGENT_MAX_NATIVE_TOTAL`), `apps/server/src/decide.ts` (cancel while queued), `packages/protocol/src/events.ts` (`agent.queued` in `TRANSIENT`, line 773), `apps/server/src/ws.ts` (re-send queued state on thread subscribe), `apps/web/src/lib/thread-store.ts`, chat composer, `apps/web/src/components/project-sessions-nav.tsx`
  - **Steps:**
    1. `acquire({ ownerId, kind, threadId, signal }) → release`, with per-user (CLI) and total (CLI, native) limits, round-robin across users, and `onChange(threadId, ahead)`.
    2. In `#run`, acquire after resolving the provider and before `turn.started`. Publish `agent.queued { threadId, ahead }` while waiting.
    3. Aborting the thread's controller rejects `acquire`, and the reactor appends `turn.dequeued { reason: "cancelled" }`.
    4. Diagram jobs count against the native limit.
    5. Web: "Queued — n ahead" with Stop in the composer; `queued` counts as working in the sidebar.
  - **Acceptance:** a burst of 20 CLI turns never runs more than `AGENT_MAX_CONCURRENT_TOTAL` `claude` processes at once (sampler). The rest run in turn, and none fail with "Too many agents".
  - **Verify:** `pnpm test -- turn-scheduler decide`, plus load with `fake-claude --rss-mb 370`
  - **Measured:** (a burst of 20 CLI turns, 5 accounts × 4 threads, `fake-claude` at 370 MB, `claude` processes sampled every 250 ms)
    - Most `claude` processes at once: 10 → 5, which is `AGENT_MAX_CONCURRENT_TOTAL`.
    - Outcomes: 10 completed and 10 failed with "Too many agents" → all 20 completed. 15 turns waited, and the last started after 76 s.
    - In Chrome, a waiting thread read "Queued — 13 ahead" down to "2 ahead" with Stop shown, then working, then done.
    - The scheduler takes a per-request `onAhead` rather than one global `onChange(threadId, ahead)`, because only the agent knows which project to publish to.

- [x] **PF1.21 — Terminal caps in config** — a202dad

  - **Depends:** PF1.10
  - **Files:** `apps/server/src/config.ts`, `apps/server/src/terminals.ts` (constants at lines 35 and 49, check at line 229), `apps/server/src/index.ts` (`TerminalOptions`), `apps/server/src/terminals.test.ts`, `.env.example`
  - **Steps:**
    1. Add `TERMINAL_MAX_PER_PROJECT` (10), `TERMINAL_MAX_PER_USER` (5), `TERMINAL_MAX_TOTAL` (40) and `TERMINAL_IDLE_MINUTES` (15).
    2. Over a cap, refuse with a visible notice via `#say`. No queue.
  - **Acceptance:** each cap refuses the next terminal with a readable message.
  - **Verify:** `pnpm test -- terminals`
  - **Measured:** (`terminals.test.ts`)
    - Over each cap the next terminal starts no shell. It prints which limit it hit, for example "You already have 5 terminals open, the most one person can. Close one to open another."
    - Closing a terminal frees its slot, and `TERMINAL_IDLE_MINUTES` sets the idle close.
    - The per-person cap (5) is new. Before, only the per-project cap existed.

- [x] **PF1.22 — Heavy-job semaphore for document tools** — 97bc20b

  - **Depends:** —
  - **Files:** `packages/agent/src/executors/host.ts` (`exec`, line 99), `apps/server/src/config.ts` (`DOC_JOBS_MAX`), `packages/agent/src/executors/host.test.ts`
  - **Steps:**
    1. Classify by argv basename (`soffice`, `libreoffice`, `mmdc`, `chromium`) or a path under `DOC_KIT_DIR`.
    2. Acquire `DOC_JOBS_MAX` (default 1), honouring the abort signal. The tool timeout starts after acquisition.
  - **Acceptance:** two concurrent document renders run one after the other, and both succeed.
  - **Verify:** `pnpm test -- host`
  - **Measured:**
    - Two renders started together run one after the other, and both succeed (`host.test.ts`, "document renders"). The second starts only after the first exits.
    - A render's timeout starts once it holds the slot: a 300 ms-timeout render waiting behind a 400 ms one still completes.
    - A render cancelled while waiting rejects at once, takes no slot, and the next waiter runs.
    - Commands that are not renders (and CLI provider shells, search) are never gated; they run while a render holds the slot.
    - `pnpm typecheck && pnpm test`: 152 files, 1933 passed, 2 skipped.

### Git (`solution.md` §10)

- [x] **PF1.23 — Server-side git cache; cheaper git reads** — fc1a816

  - **Depends:** —
  - **Files:** new `apps/server/src/git-cache.ts` and `git-cache.test.ts`, `apps/server/src/git-routes.ts` (status line 103, branches line 156, log line 122; `announce`), `apps/server/src/git.ts` (`status`, lines 97–127), `apps/server/src/git-exec.ts` (line 73)
  - **Steps:**
    1. Cache `{ status, branches, log0, isRepo, version, at }` per tree, with singleflight. Invalidate on watcher bursts, git mutations and `bus.tap` events (`file.changed`, `git.committed`, `git.pushed`). Maximum age 5 min.
    2. After an invalidation, publish one transient `resource.changed { resource: "git", projectId }`, debounced 300 ms. Never push the status itself.
    3. The routes read through the cache, with an `ETag` = version and 304 support.
    4. Set `GIT_OPTIONAL_LOCKS=0` on read commands, and merge the two `rev-parse` calls.
  - **Acceptance:** with 10 viewers on one project, one file-change burst runs ≤ 3 git processes for that tree.
  - **Verify:** `pnpm test -- git-cache git`, plus load
  - **Measured:**
    - With 10 viewers refetching as the view does, one burst of 20 file writes ran 80 git processes before and 3 after (`status`, `rev-parse`, `remote`). 20 of the 30 refetches were answered 304.
    - Load run p50/p95 for git status reads: 30.8/37.5 → 8.5/54.5 ms. The slower tail is the cold first reads. No errors.

- [x] **PF1.24 — Watch `.git` and session worktrees; `worktreeId`; burst cap** — efadda5

  - **Depends:** PF1.23
  - **Files:** `apps/server/src/file-watcher.ts` (ignores at line 33, `#flush` at line 118), `apps/server/src/trees.ts` (worktree paths, lines 20–25), `apps/server/src/ws.ts` (project subscribe `tree`), `packages/protocol/src/events.ts` (`file.changed.worktreeId`, `LiveResource` `"files"`), `apps/web/src/components/files-panel.tsx`, new `apps/server/src/file-watcher.test.ts`
  - **Steps:**
    1. Add a second subscription on `<root>/.git`, ignoring `objects/**`, `logs/**` and `*.lock`. Changes to `HEAD`, `index`, `refs/**`, `packed-refs`, `FETCH_HEAD` or `worktrees/*/{HEAD,index}` invalidate the git cache for the checkout and the project's worktrees.
    2. Session worktrees are watched while a subscription names them (`tree: sessionHash`).
    3. `file.changed` gains `worktreeId`, and `files-panel.tsx` filters by the tree it shows.
    4. Above 200 paths per burst, publish one `resource.changed { resource: "files", projectId, tree }`.
  - **Acceptance:** a `git commit` typed in a terminal appears in the Git view within 1 s. An `npm install` outside `node_modules` produces one files event, not thousands.
  - **Verify:** `pnpm test -- file-watcher`, plus manual
  - **Measured:** (the real watcher on a git repo)
    - `git commit` → `onGitChange` 198 ms after git exits, then the git cache's 300 ms debounce to `resource.changed{git}`: about 0.5 s, against the next 60 s poll before.
    - 2,000 files written under `build/` plus 2,000 under `node_modules`: 1 `resource.changed{files}` and 0 `file.changed`, against 2,000 events before.
    - One tree is watched per project subscription. When two views in a tab hold different trees, the latest one wins.
    - A watch opened before its folder existed is retried on `project.cloned` and `thread.worktree_ready` (`rearm`).

- [x] **PF1.25 — Git view as queries; no polling** — 8912dd1

  - **Depends:** PF1.23, PF1.24
  - **Files:** `apps/web/src/components/git/use-git-state.ts` (`POLL_MS` line 28, `refresh` lines 94–117, diff effect lines 200–215), `apps/web/src/lib/git-api.ts`, `apps/web/src/lib/realtime-cache.ts`, `apps/web/src/lib/query-keys.ts`
  - **Steps:**
    1. Status, branches and log page 0 become `useQuery` with `staleTime: Infinity`, invalidated on `resource.changed{git}`, `git.committed` and `git.pushed`.
    2. `file.changed` no longer invalidates `qk.git.all`.
    3. Delete `POLL_MS`.
    4. Refetch the selected diff only when its file's status entry changes.
  - **Acceptance:** no periodic git requests from an idle Git view (DevTools network panel over 5 min).
  - **Verify:** standard, plus manual
  - **Measured:** (headless Chrome on the load image, a project's Git view)
    - Git requests from an idle Git view over 5 min: 15 before (3 every 60 s), 0 after.
    - A file written in the container shows in the changes list 690 ms later. A `git commit` run in the container takes it off the list 690 ms after the commit returns. PF1.24's acceptance is under 1 s.
    - Each change refetches status, branches and log once (3 requests). The server answers unchanged reads from its cache.
    - The selected diff is also read again when its file is written while its status entry stays the same (a second edit of a modified file). Otherwise the diff would go stale.
    - The queries also refetch when the view opens, since events can be missed while it is closed. A repository watch that starts fresh invalidates the git cache once, and a `.git` appearing in the checkout (`git init`) starts the repository watch.

### Subscriptions and runtime (`solution.md` §11–§12)

- [x] **PF1.26 — Workspace activity topic; only file views retain the watcher** — edc0931

  - **Depends:** PF1.2
  - **Files:** `apps/server/src/index.ts` (a `bus.tap` deriving `project.activity`), `apps/server/src/bus.ts` (`publishToWorkspace`), `apps/server/src/ws.ts` (`onProjectWatch` at lines 284–287 and 472–476: only `files: true`), `packages/protocol` (`project.activity` transient event; project subscribe `files` flag), `apps/web/src/lib/realtime.tsx` (`useAgentActivity` at lines 160–182; quiet subscriptions at lines 140, 182, 256), `apps/web/src/components/session-list.tsx`, the views that need files (Git view, files panel, code editor, the chat's file pane) via `useProjectEvents({ files: true })`
  - **Steps:**
    1. Derive `project.activity { projectId, threadId, state }` from turn edges and `turn.dequeued`, and publish it to `workspace:<id>`, using a cached project → workspace map.
    2. `useAgentActivity` and the session list read it from the workspace topic. Delete the per-project quiet subscriptions.
    3. Only subscriptions with `files: true` call `onProjectWatch`.
  - **Acceptance:** about 4 subscriptions per socket (metrics). `watched_projects` equals the number of projects open in a view that shows files.
  - **Verify:** `pnpm test -- ws`, plus load
  - **Measured:**
    - Subscriptions per socket under the PF0 load: 23 before (1,000 project subscriptions for 50 sockets), 4 after.
    - `watched_projects` max: 20 before (every listed project), 15 after, one per git-role user with the Git view open.
    - `project.activity` reaches the sidebar 0.30 ms p50 and 1.81 ms p99 after the thread's own `turn.started`.
    - The files panel holds the watcher while its tree or a file tab is open, and rereads the tree when shown again. The Git view and the diagram editor hold it while mounted.

- [ ] **PF1.27 — Runtime: heap flags, DB pool, logging, Postgres defaults**

  - **Depends:** PF0.9
  - **Files:** `deploy/s6/s6-rc.d/server/run` (line 53), `deploy/s6/s6-rc.d/web/run` (lines 9–14), `deploy/s6/s6-rc.d/postgres/run` (flags at lines 64–71), `packages/db/src/index.ts` (line 24, `createDatabase`/`createClient`), `apps/server/src/config.ts` (`DB_POOL_MAX`, `LOG_LEVEL`, `LOG_SLOW_MS`), `apps/server/src/index.ts` (logger at line 550), `.env.example`, `README.md` ("Scaling")
  - **Steps:**
    1. `--max-old-space-size=${SERVER_HEAP_MB:-1536}` and `${WEB_HEAP_MB:-1024}` **on the `node` command lines**. Never `NODE_OPTIONS`, which `terminalEnv` would pass to user shells.
    2. `DB_POOL_MAX` (default 20) for both pools.
    3. `LOG_LEVEL`; `disableRequestLogging: true`, plus an `onResponse` log for requests slower than `LOG_SLOW_MS` or returning 5xx.
    4. Postgres defaults from `solution.md` §12, each overridable by env.
    5. Document every new variable.
  - **Acceptance:** under the 50-user load, API RSS < 1.2 GB, no swap-in, cgroup `oom_kill` = 0.
  - **Verify:** `bash scripts/smoke-container.sh`, plus load

---

## Phase PF2: Operations

**Design:** `solution.md` §13.

- [ ] **PF2.1 — CI workflow**

  - **Depends:** —
  - **Files:** new `.github/workflows/ci.yml`
  - **Steps:** On push and PR: pnpm install (cached), `pnpm typecheck && pnpm test`, `pnpm --filter @ucch/web build`, `node apps/web/scripts/bundle-budget.mjs --check`.
  - **Acceptance:** a PR shows the check, and a failing test fails it.
  - **Verify:** push a branch

- [ ] **PF2.2 — Build images in CI; Dokploy pulls them**

  - **Depends:** PF2.1
  - **Files:** new `.github/workflows/image.yml`, `Dockerfile` (delete the deprecated `web` and `server` stages at lines 141–172), `README.md` ("Deploying on Dokploy")
  - **Steps:**
    1. On push to `main`, run `docker/build-push-action` with `target: app`, `cache-from/cache-to: type=gha,mode=max` and `BUILD_ID=${{ github.sha }}`, tagging `ghcr.io/<owner>/ucch:<sha>` and `:main`.
    2. Then `curl -fsS -X POST "$DOKPLOY_DEPLOY_WEBHOOK"`.
    3. README: switch the Dokploy application to the Docker image provider (registry credentials, deploy webhook). `docker build .` still works locally.
  - **Acceptance:** a push to `main` deploys without any build running on the VPS.
  - **Verify:** one real deploy

- [ ] **PF2.3 — Container limits and child priorities**

  - **Depends:** PF0.2
  - **Files:** new `apps/server/src/child-priority.ts` (argv prefix helper), `packages/providers/src/process.ts` (line 113), `packages/agent/src/executors/host.ts` (line 99), `apps/server/src/terminals.ts` (line 242), `apps/server/src/config.ts` (`CHILD_OOM_ADJ`, `CHILD_NICE`), `README.md`
  - **Steps:**
    1. The helper prefixes `choom -n ${CHILD_OOM_ADJ:-800} -- nice -n ${CHILD_NICE:-10} ionice -c2 -n7`, with gentler values for terminals (`choom -n 500`, `nice 5`).
    2. Check the tools exist at boot and fall back to the bare argv. Not on `runGit`. **Never `prlimit --as`.**
    3. README: Dokploy → Advanced → Resources: memory limit 7168 MB, reservation 4096 MB, no CPU limit.
  - **Acceptance:** a deliberately runaway dev server (`node -e "a=[];setInterval(()=>a.push(Buffer.alloc(1e8)),10)"` in a terminal) is OOM-killed while the API and Postgres keep running.
  - **Verify:** `pnpm test`, plus that manual check

- [ ] **PF2.4 — In-process alerts**

  - **Depends:** PF0.2
  - **Files:** new `apps/server/src/watchdog.ts` and `watchdog.test.ts`, `apps/server/src/config.ts` (`ALERT_WEBHOOK_URL`)
  - **Steps:**
    1. Alert when:
       - cgroup memory is above 85% for 2 min;
       - event-loop p99 is above 200 ms for 1 min;
       - the `oom_kill` count increases;
       - engine wait p99 is above 500 ms for 1 min.
    2. Each alert logs at error and POSTs JSON to `ALERT_WEBHOOK_URL`, at most once per 15 min per condition.
  - **Acceptance:** a test fires each condition once and rate-limits the repeat.
  - **Verify:** `pnpm test -- watchdog`

---

## Phase PF3: Re-measure and decide

- [ ] **PF3.1 — Re-measure**

  - **Depends:** every PF1 task except PF1.12, plus PF2.3
  - **Files:** new `documentation/perf/after-<date>.json`, `documentation/perf/README.md`
  - **Steps:** Re-run exactly the PF0.9 profile. Fill the "After" column of the Definition of Done table, and write a before/after table.
  - **Acceptance:** every Definition of Done target is met, or the gap is explained.
  - **Verify:** review

- [ ] **PF3.2 — Record the Rust decision**

  - **Depends:** PF3.1
  - **Files:** `documentation/plan.md` (§8)
  - **Steps:** Apply the plan.md §6 Phase 3 checklist to the PF3.1 numbers and record the decision with its numbers. If it qualifies, add a new phase to this file for the Rust edge daemon.
  - **Acceptance:** plan.md states the decision and the measurements behind it.
  - **Verify:** review

---

## Carried over: still open from the previous list

These are unchanged in substance. Their dependencies on completed tasks are dropped and new ones added.

- [ ] **B11 (rest) — Bundle splitting**

  > PARTIAL (from the previous list): done -- analyzer behind `ANALYZE=1`, `optimizePackageImports`, `scripts/bundle-budget.mjs --check`, shell dialogs and the search panel behind `dynamic()` via `components/on-demand.tsx`, lazy login boot screen. Shell routes 329 → 308 kB (baseline 315: −2%). The zod part is now PF1.18.
  >

  - **Depends:** PF1.18
  - **Files:** cmdk users (palette, workspace switcher, view toggle), `components/files-panel.tsx` (split out `FilesTree`), `lib/warmup.ts` (`CHUNKS`)
  - **Steps:**
    1. Move the cmdk popovers behind `dynamic()`, with skeleton placeholders and idle warming.
    2. Split `FilesTree` out of `files-panel.tsx`.
  - **Acceptance:** shell-route first-load JS ≥ 10% below the 315 kB baseline (target revised from −25%; the rest is `@base-ui/react` and the framework).
  - **Verify:** `ANALYZE=1 pnpm --filter @ucch/web build`, plus the budget script

- [ ] **R5 (rest) — Fill missing events**

  > PARTIAL (from the previous list): done -- git remote PUT/DELETE and fetch, diagram jobs, files panel takes agent/git writes, task routes in SELF_AUDITED. `worktreeId` on `file.changed` is now PF1.24.
  >

  - **Depends:** PF1.26
  - **Files:** `apps/server/src/preview.ts`, `apps/server/src/decide.ts`, `apps/server/src/uploads.ts`, `apps/server/src/route-audit.ts`, `packages/protocol/src/events.ts`, `apps/web/src/components/preview-dialog.tsx`, `apps/web/src/lib/realtime-cache.ts`
  - **Steps:**
    1. Emit the already-defined `preview.published`, `port.opened` and `port.closed` where publishing and port detection happen. `preview-dialog.tsx` stops polling.
    2. Upload delete and attach → `upload.changed`. Attach's `file.changed` gets `origin: "system"`.
    3. Add the cache-bridge mappings for every new event.
  - **Acceptance:** publishing a preview, a port opening or closing, and deleting an upload each appear live in a second browser without a refresh.
  - **Verify:** `pnpm test`, plus a manual two-browser check

- [ ] **R8 — Hocuspocus server on `/collab`, as its own service**

  - **Depends:** PF3.1
  - **Files:**
    - new `apps/collab/` (or `apps/server/src/collab.ts` started as a separate entry point) and `collab.test.ts`
    - new s6 service `deploy/s6/s6-rc.d/collab/` with `--max-old-space-size=${COLLAB_HEAP_MB:-512}`
    - `apps/server/src/index.ts`: proxy `/collab` upgrades to it, the way `web-proxy.ts` does
    - `packages/db/src/schema.ts` + new migration `note_ydocs`, `apps/server/src/notes.ts`
    - dependencies: `@hocuspocus/server`, `yjs`, `y-prosemirror`, `@tiptap/*` for server-side schema conversion, pinned to versions matching the web's Tiptap 3.31.3
  - **Steps:**
    1. Run Hocuspocus **in its own process** on loopback (`COLLAB_PORT`). The server proxies `/collab` upgrades to it. Cap open documents with `COLLAB_MAX_DOCS`.
    2. `onAuthenticate`: redeem a ws-ticket (via an internal loopback call to the server), parse the document name `note:{id}`, and check the note's project access. Reject otherwise.
    3. Add the table `note_ydocs(note_id pk fk→notes on delete cascade, state bytea not null, updated_at)`.
    4. `onLoadDocument`: load the state, or seed it once from `notes.content` (Markdown → ProseMirror JSON with the same extension set as `note-editor-impl.tsx` → `prosemirrorJSONToYDoc`).
    5. `onStoreDocument` (debounce 2 s, max 10 s): save the state **and** project it to `notes.content` as Markdown. Publish `note.changed` without content.
    6. Unload documents 30 s after the last connection. Report the open-document count in `/metrics`.
    7. Route server-side writes (the agent's document tools, REST content PATCH) through `openDirectConnection`.
    8. Tests:
       - two clients converge;
       - an unauthorized client is rejected;
       - the projection writes `content`;
       - a server-side write reaches connected clients.
  - **Acceptance:** two headless Yjs clients editing the same note converge, and `notes.content` reflects the merge within 10 s. Under the PF0 load plus 20 co-editors, the API's event-loop p99 is unchanged.
  - **Verify:** `pnpm test -- collab`, plus load

- [ ] **R9 — Notes editor co-editing**

  - **Depends:** R8
  - **Files:** `apps/web/src/components/notes/note-editor-impl.tsx`, `note-editor.tsx`, `notes-workspace.tsx`, `apps/web/src/lib/note-autosave.ts`, `apps/web/package.json` (`@hocuspocus/provider`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `yjs`; exact versions matching Tiptap 3.31.3)
  - **Steps:**
    1. Create a `HocuspocusProvider` per open note: URL `/collab` on the page host, with a ticket from `POST /api/ws-ticket`.
    2. Add the Collaboration extension, and disable StarterKit `undoRedo`.
    3. Add CollaborationCaret with the user's name and colour from presence.
    4. Remove the content autosave path, the whole-document `setContent` on `note.changed` and the `ifUpdatedAt` 409 handling for content. Title, icon and cover stay on REST.
    5. While the provider is syncing, show `NotePageSkeleton`; after the first sync, the editor.
    6. Offline: Yjs keeps local edits and syncs them on reconnect. Show the reconnect banner.
  - **Acceptance:** two browsers type in the same paragraph at once with live carets, and nothing is lost or reverted.
  - **Verify:** `pnpm --filter @ucch/web build`, a manual two-browser check, and an e2e test with two contexts

- [ ] **R10 — Code and diagram co-editing**

  - **Depends:** R9, PF1.24
  - **Files:** the collab service (file documents), `apps/server/src/files.ts`, `apps/server/src/file-watcher.ts`, `apps/web/src/lib/doc-sync.ts` (move `replacement()` into `packages/protocol` and re-export), `apps/web/src/components/code-editor.tsx`, `components/diagrams/diagram-editor.tsx`, `y-codemirror.next`
  - **Steps:**
    1. Document name `file:{projectId}:{worktreeId}:{path}`. Load from disk, with no DB persistence.
    2. Write back to disk with a 1 s debounce through `workspaceFiles.write`, which bumps the version so the watcher skips it.
    3. When the watcher or the agent reports an external change, apply `replacement(docText, diskText)` as one Yjs transaction.
    4. Unload after 30 s idle.
    5. Client: a `yCollab` extension in CodeMirror, with vim mode still working. Remove `ifVersion` save conflicts for co-edited files.
  - **Acceptance:** two users edit the same file live. An agent edit to that file merges into both editors without moving cursors.
  - **Verify:** `pnpm test -- collab`, plus manual

- [ ] **R11 — Optimistic, per-field mutations for tasks and timeline**

  - **Depends:** —
  - **Files:** `apps/server/src/tasks-routes.ts`, `apps/server/src/tasks.ts`, `apps/server/src/timeline-routes.ts`, `apps/web/src/lib/queries/tasks.ts`, `apps/web/src/lib/queries/timeline.ts`
  - **Steps:**
    1. PATCH accepts partial fields and updates only those columns.
    2. Events carry the updated entity, and the bridge patches it into the cache.
    3. Mutation hooks update optimistically.
  - **Acceptance:** two users dragging different tasks, or editing different fields of one task, never overwrite each other.
  - **Verify:** `pnpm test -- tasks timeline`

- [ ] **R12 — DB-manager row conflict detection**

  - **Depends:** —
  - **Files:** `apps/server/src/db-manager/adapter.ts`, `apps/server/src/database-routes.ts`, `apps/web/src/components/database/browse-tab.tsx`
  - **Steps:**
    1. Row update requests include the original values of the changed columns, and the adapter adds them to the `WHERE`.
    2. If 0 rows are affected, return `409` with the current row.
    3. The UI shows a conflict toast with "Use theirs / Overwrite".
    4. A successful update publishes `resource.changed{database_data, table}` to the workspace topic.
  - **Acceptance:** concurrent edits of one cell produce a visible conflict, not a silent overwrite.
  - **Verify:** `pnpm test -- database`

- [ ] **W1 — Manifest, icons, theme colour**

  - **Depends:** —
  - **Files:** new `apps/web/src/app/manifest.ts`, new icons in `apps/web/src/app/` (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`), `apple-icon.png` replaced with 180×180, `apps/web/src/app/layout.tsx` (`export const viewport = { themeColor }`), `apps/web/src/middleware.ts` matcher (exclude `manifest.webmanifest`)
  - **Steps:** Generate the icons from `icon.svg` or `components/app-logo.tsx`. Manifest values: `display: "standalone"`, `start_url: "/"`, `scope: "/"`, and colours from theme tokens.
  - **Acceptance:** Chrome DevTools → Application → Manifest shows no errors.
  - **Verify:** `pnpm --filter @ucch/web build`, plus DevTools

- [ ] **W2 — Static root layout**

  - **Depends:** W1
  - **Files:** `apps/web/src/app/layout.tsx`, `apps/web/src/lib/theme.ts`, `apps/web/src/components/theme-provider.tsx`, `apps/web/src/middleware.ts`
  - **Steps:**
    1. Stop calling `cookies()` in the root layout. Either:
       - apply the theme on the client from cookie or localStorage before first paint, through the existing `ThemeProvider`; **or**
       - keep `(app)` dynamic and make only `/login` and `/offline` static, through a separate root layout group.

       Choose the second if the first causes a visible flash, and document the choice in the PR.
    2. **Don't break the hydration rules documented in `layout.tsx`.**
  - **Acceptance:** the `next build` output marks `/login` as static (○). No theme flash on a forced-dark reload.
  - **Verify:** `pnpm --filter @ucch/web build`

- [ ] **W3 — Serwist service worker behind a flag**

  - **Depends:** W2, PF1.4
  - **Files:** `apps/web/next.config.ts` (`withSerwist`, enabled only when `NEXT_PUBLIC_PWA=1`), new `apps/web/src/app/sw.ts`, `apps/web/package.json` (`@serwist/next`, `serwist`)
  - **Steps:**
    1. Precache the build-manifest entries for the shell route chunks, the fonts and `/offline`.
    2. Runtime caching:
       - `/_next/static` cache-first;
       - `/file-icons/svg/*` stale-while-revalidate;
       - navigations network-first with a 3 s timeout, then the cached shell, then `/offline`;
       - RSC (`RSC: 1` header) network-only.
    3. **Exclude:** `/api/*`, `/ws`, `/collab`, preview hosts.
    4. Register only in production when the flag is on.
    5. The server's edge (`web-proxy.ts`) serves `sw.js` with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`.
  - **Acceptance:** with the flag on, Lighthouse's PWA "installable" check passes. Turning the flag off and redeploying unregisters the worker (ship a kill-switch `sw.js`).
  - **Verify:** `NEXT_PUBLIC_PWA=1 pnpm --filter @ucch/web build && start`, plus Lighthouse

- [ ] **W4 — Offline page**

  - **Depends:** W3
  - **Files:** new `apps/web/src/app/offline/page.tsx` (static)
  - **Steps:** Show the app logo, "You're offline", a retry button, and a read-only list of recent projects from the persisted query cache.
  - **Acceptance:** in DevTools offline mode, a navigation shows this page.
  - **Verify:** manual

- [ ] **W5 — Update prompt and install entry**

  - **Depends:** W3, PF1.14
  - **Files:** new `apps/web/src/components/update-toast.tsx`, `apps/web/src/components/nav-user.tsx`
  - **Steps:**
    1. Show "New version available — Reload" when the socket's `ready.buildId` (PF1.14) or bootstrap's `buildId` differs from the running build (`process.env.NEXT_PUBLIC_BUILD_ID`), or when the service worker reports `waiting`.
    2. Capture `beforeinstallprompt` and show an "Install app" item in the user menu.
  - **Acceptance:** deploying a new build while a tab is open shows the toast, and reloading picks up the new version.
  - **Verify:** manual

---

## Definition of Done

Measured with `scripts/load/run.mjs --users 50` against the production image under `--cpus=4 --memory=8g`, plus `pnpm --filter @ucch/web e2e` (`perf.spec.ts`, `stream.spec.ts`) running alongside. PF0.9 fills the Baseline column; PF3.1 fills After. `scripts/load/profile.sh` runs the whole profile; [`perf/README.md`](./perf/README.md) says how each figure is taken, and `perf/baseline-2026-10-25.json` holds them.

| Metric | Baseline (PF0.9) | Target | After (PF3.1) |
| --- | --- | --- | --- |
| RSC requests caused by one fresh sign-in | 115 | ≤ 15 | |
| RSC requests in other tabs when a member saves settings | 115 per tab | 0 | |
| Sign-in submit → interactive shell | 1.99 s (idle 2.03 s) | ≤ 2.0 s | |
| Click → skeleton or new page (p95) | 87 ms | ≤ 100 ms under load | |
| Click → content, cached data (p95) | 121 ms | ≤ 150 ms under load | |
| Click → content, cold data (p95) | 381 ms | ≤ 600 ms under load | |
| Bootstrap server time (200 projects / 20k turns, p95) | 74 ms | < 15 ms | |
| Terminal keystroke echo (p95 / p99) | 2.7 ms / 7.3 ms | < 30 ms / < 60 ms | |
| Engine wait (p99) | < 1 ms | < 20 ms | |
| WebSocket frames per 2,000-token answer | 2,026 | ≤ ⅓ of baseline | |
| Long tasks > 50 ms while streaming a 4,000-token answer | 0 (0 at 4× CPU throttle) | 0 | |
| INP while streaming | 48 ms | < 200 ms | |
| Git processes per file-change burst, 10 viewers | 80 | ≤ 3 | |
| Concurrent `claude` processes during a 20-turn burst | 20 of 20, uncapped, none failed | ≤ `AGENT_MAX_CONCURRENT_TOTAL`, none failed | |
| Subscriptions per socket | P + 3 over 2 sockets (22 + 1) | ≈ 4 | |
| `/ws` connections per tab | 2–3 on a chat page | 1 | |
| API RSS under load | 352 MB | < 1.2 GB | |
| Event-loop delay p99 under load | 14 ms | < 50 ms | |
| cgroup `oom_kill` during the run | 0 | 0 | |
| Builds on the VPS per deploy | 1 | 0 | |
| Shell-route first-load JS | 314 kB gz | ≤ 285 kB | |
