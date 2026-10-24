# UCCH performance: the solution design

**Status:** approved design · **Date:** 2026-10-24 · **Why:** [`plan.md`](./plan.md) · **Tasks:** [`todo.md`](./todo.md)

`plan.md` found that the lag and memory use on the 4 vCPU / 8 GB Dokploy VPS come from how UCCH is put together, not from Node.js. This document describes the fix for each problem: what changes, in which files, what can break and how it is tested. `todo.md` turns it into ordered tasks.

The previous contents of this file (a sign-in fix for the old two-app Dokploy setup) are in git: `git show 9519ddb:documentation/solution.md`.

Every section has the same shape: **Problem** (with code references), **Design**, **Protocol / data changes**, **Risks**, **Tests**, **Acceptance**.

---

## 0. Principles

1. **Measure first.** Every fix has a number attached, taken before and after under the same load (§1).
2. **Correctness before concurrency.** Some invariants are currently protected by accident, by the single global command queue, or not protected at all. Fix those (§2) before anything runs in parallel (§6).
3. **Deploys must not break open tabs.** A tab loaded before a deploy keeps talking to the new server. New frame kinds are opt-in by a capability flag, and the server keeps accepting old frames for at least one release.
4. **Prefer deleting work to speeding it up.** Most of the wins below come from not doing something at all: not pre-rendering, not polling, not re-rendering on every token.
5. **Defaults must fit the box.** Every new limit has a default that fits 8 GB, and an env var to change it.

---

## 1. Measurement (PF0)

### Problem

No metrics exist. `/health` (`apps/server/src/index.ts:677`) reports status and connection count only. There is no `perf_hooks` or `process.memoryUsage` use anywhere, and the logger level is fixed by `NODE_ENV` (`index.ts:550`). The only numbers in the repo are single-user browser timings (`apps/web/e2e/results/`).

### Design

**`/metrics`** (new `apps/server/src/metrics.ts`, wired in `index.ts`)

- Format: Prometheus text, hand-rolled. One small registry of counters, gauges, and histograms with fixed buckets. No new dependency.
- Access:
  - With `METRICS_TOKEN` set, require `Authorization: Bearer <token>`, compared with `timingSafeEqual`.
  - Without it, allow only requests whose `request.socket.remoteAddress` is `127.0.0.1` or `::1`. Use the socket address, not `request.ip`, which proxy trust can rewrite. Traefik reaches the container over the Docker network, so outside traffic never passes.
  - There is no server-wide admin role to check against: every session gets every scope (`index.ts:3119`), and roles are per workspace.
- What it exports:

  | Family | Source |
  |---|---|
  | `event_loop_delay_seconds` p50/p99/max (reset per scrape, plus a 60 s rolling window); `event_loop_utilization` | `monitorEventLoopDelay({ resolution: 10 })`, `performance.eventLoopUtilization()` |
  | `process_heap_bytes`, `process_rss_bytes`, `gc_pause_seconds{kind}` | `process.memoryUsage()`, GC `PerformanceObserver` |
  | `engine_queue_depth`, `engine_wait_seconds{command}`, `engine_process_seconds{command}` | `OrchestrationEngine.#process` (`engine.ts:77`), `worker.outstanding` (`worker.ts:32`) |
  | `ws_connections`, `ws_subscriptions{topic}`, `ws_frames_out_total{kind,event}`, `ws_bytes_out_total`, `ws_frames_in_total{kind}` | `ws.ts` `sendRaw` / `sendPush` / `#onMessage` |
  | `bus_publish_total{event}` | a `bus.tap` |
  | `agent_turns{state,provider}`, `terminals_open`, `watched_projects`, `clone_queue_depth`, `worktree_queue_depth` | `agentTurns.activeTurns`, `terminals.openTerminals`, `fileWatcher.watchedProjects`, `clones.worker`, `worktrees.worker` |
  | `http_request_seconds{route,status}` | fastify `onResponse`, labelled with `routeOptions.url` (the template, not the URL) |
  | `pg_connections{state}` | `pg_stat_activity`, queried at scrape time |

**Resource sampler** (new `apps/server/src/resource-sampler.ts`)

- Every 15 s, read `/proc/*/stat` and `/proc/*/statm`. Both are world-readable, so the `node` user can read them.
- Group processes by s6 service, found through the parent chain of the root PIDs: `postgres`, Next (`node server.js`), the API (`server.mjs`), `mysqld`.
- Group the server's descendants by class: `claude`, `codex`, pty shells, `git`, `rg`, `python`, `soffice`, `chromium`, and `other` (users' dev servers).
- Postgres backends each count `shared_buffers` in their RSS. Report Postgres as `sum(rss − shared)` plus `shared_buffers` (statm field 3 is shared pages).
- Also read the container cgroup: `/sys/fs/cgroup/memory.current`, `memory.max`, `memory.stat` (anon/file), and `memory.events` (`oom_kill`).
- Export everything as gauges (`resource_rss_bytes{group}`, `resource_cpu_seconds_total{group}`, `cgroup_memory_bytes`, `cgroup_oom_kills_total`). With `LOG_RESOURCE_SAMPLES=true`, also log one line per sample.

**Postgres statistics** (`deploy/s6/s6-rc.d/postgres/run`)

- Add `-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top -c pg_stat_statements.max=5000 -c track_io_timing=on -c log_min_duration_statement=${PG_LOG_MIN_DURATION_MS:-500}`.
- In the existing readiness subshell, once Postgres answers, run these as the `postgres` user. They are idempotent:
  - `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` in database `ucch`
  - `GRANT pg_read_all_stats TO ucch`

  The extension is not "trusted", so a superuser has to create it.
- New `scripts/pg-top.sh`: `docker exec <container> psql` printing the top 20 statements by `total_exec_time` and by `calls`. `--reset` calls `pg_stat_statements_reset()`.
- With an external `DATABASE_URL`, these steps are manual; the README says how.

**Proxy counters** (`apps/server/src/web-proxy.ts`)

- Count proxied requests by class:
  - `document`
  - `rsc` (request header `rsc: 1`)
  - `rsc_prefetch` (`next-router-prefetch: 1`)
  - `static`
- Record an upstream-latency histogram.
- Count `/api/bootstrap` calls by caller: SSR loopback vs browser.
- These are the numbers that prove §3 and §4 worked.

**Load fixtures**

- `OPENROUTER_BASE_URL` in `config.ts`, defaulting to today's constant (`openrouter.ts:18`), threaded through `openrouter.ts`.
- `scripts/load/mock-openrouter.mjs`: an SSE server with a configurable token rate, chunk size and answer length. It also serves the model-catalogue endpoints `contextLengthFor` and `supportsImages` call.
- `scripts/load/fake-claude.mjs`: replays stream-json fixtures (taken from `packages/providers/src/claude.test.ts`) when pointed to by `CLAUDE_BIN`. `--rss-mb N` allocates and holds memory to mimic the real CLI's 372 MB.

**Seeding** (new `apps/server/scripts/seed-load.ts`, run with `tsx`)

- Refuses to run unless `LOADTEST_ALLOW_SEED=1` is set and the database name ends in `_load`.
- Creates N users with real password hashes (`apps/server/src/password.ts`) and an encrypted dummy OpenRouter key (`apps/server/src/crypto.ts` with `SECRET_KEY`).
- Creates one shared workspace with every user as a member, plus each user's personal workspace (`ensureDefault`).
- Creates sessions directly (`AuthService.createSession`), because `/api/auth/login` is limited to 20 per minute per IP (`index.ts:3104`). Writes `{ userId, cookie }[]` to `$LOAD_OUT/sessions.json`.
- Creates P projects per workspace through a real WebSocket `project.create`, so the clone reactor runs (`repoUrl` null, so the repos are empty).
- `DEV_AUTH_BYPASS` is no use here: it maps every socket to one principal (`auth.ts:65`, `:116`).

**Load generator** (new `scripts/load/run.mjs`, built on `scripts/smoke-phase1.mjs`)

- Every virtual user:
  - gets a `ws-ticket`, opens `/ws`, and subscribes to `user`, `workspace`, and a quiet `project` topic for each listed project, the way the sidebar does today;
  - every 30 s, fetches `GET /api/bootstrap`, one document, and 5 RSC prefetches through :3000;
  - keeps a `thread` subscription open, with replay.
- The mix:
  - 20% send a native turn every 60 s (the mock streams 1,500 tokens at 60 tokens/s);
  - 30% type in a terminal at 5 characters/s;
  - 30% fetch git status, branches and log every 60 s, as `use-git-state.ts` does today.
- It records histograms of:
  - ack round-trip by command;
  - keystroke echo: send until the first `terminal.output` containing the character;
  - frames and bytes per turn;
  - bootstrap latency and document TTFB.
- It scrapes `/metrics` every 5 s.
- The target is the production image under `docker run --cpus=4 --memory=8g`. Run the generator from another machine, or pinned with `taskset` to cores the container doesn't use.
- Alongside the load, 2–3 Playwright browsers run `apps/web/e2e/perf.spec.ts` plus a new streaming scenario, so browser timings are measured under load.

**Real-user metrics** (this absorbs the old B13)

- New `apps/web/src/components/vitals-reporter.tsx`, using `web-vitals`. It reports via `navigator.sendBeacon`:
  - LCP, INP, CLS and TTFB;
  - `nav-skeleton` and `nav-content` (marked in `TransitionLink`, `lib/view-transitions.tsx:145`);
  - `frame-to-paint`: the next animation frame after the chat store commits;
  - `keystroke-to-echo`, in `terminal-view.tsx`.
- `POST /api/metrics/vitals` is rate-limited and aggregates into `/metrics` histograms by route template.
- There is no table and no migration, so nothing personal is stored and nothing grows.

**Baseline**

- Write `documentation/perf/baseline-<date>.json` and a Markdown summary. Columns:
  - CPU and RSS per service and per child class;
  - event-loop p99 and utilisation;
  - the top 10 statements;
  - RSC renders for one fresh login;
  - keystroke echo p95, token-to-paint p95, nav-skeleton p95;
  - frames per turn.

### Risks

- **`/metrics` exposed.** The loopback check fails safe when unset: Traefik and the Docker network never present loopback.
- **Sampler cost.** Reading a few hundred `/proc` files every 15 s is trivial, but cap it at 2,000 PIDs per sample.

### Tests

- `metrics.test.ts`: text format and the three access cases (token, loopback, remote).
- `resource-sampler.test.ts`: the `/proc` and cgroup parsers against fixture strings.

### Acceptance

The baseline file exists and states the RSC-render count for one fresh login.

---

## 2. Correctness prerequisites (PF1.1, PF1.2)

These fix bugs that already exist and become more likely once §6 runs commands in parallel.

### 2.1 Event sequence numbers

**Problem**

- `EventStore.append` takes `select max(seq)` per append (`eventstore.ts:181-192`).
- Thread events are guarded by a unique `(thread_id, seq)` index. Project-scoped events (`thread_id IS NULL`) are not: `events_project_seq_idx` (migration `0019_perf_indexes.sql`, `packages/db/src/schema.ts:381`) is a plain partial index, and NULLs are distinct under a unique index anyway.
- Many writers append project-scoped events outside the engine: the clone reactor, `announceFileChange`, session lifecycle, `#recheckStack`, the routes in `index.ts:1573-1848`.
- Two of them can therefore write the same seq. The browser dedupes on `p:<projectId>:<seq>` (`apps/web/src/lib/client.ts:398-409`), so it silently drops one real event.
- On thread streams, a `thread.cancel` racing the agent reactor's own appends hits the unique index and surfaces to the user as `internal`.

**Design**

1. Inside the append transaction, before `nextSeq`, run `select pg_advisory_xact_lock(hashtextextended($1, 0))` as its own statement, with key `thread:<id>` or `project:<id>`.
   - It must be a separate statement. Under READ COMMITTED each statement takes its own snapshot, so a `max(seq)` in the same statement as the lock could read a value from before the lock was granted.
   - It costs one extra round trip per durable append. Transient-only appends skip the transaction entirely, as now (`eventstore.ts:38-41`).
2. Migration `0025_event_stream_seq.sql`:
   - renumber the existing project-scoped events;
   - drop the plain index;
   - recreate it as a unique partial index;
   - change `schema.ts` to `uniqueIndex("events_project_seq_idx")…where(…)`.

   ```sql
   WITH r AS (
     SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY id) - 1 AS s
     FROM events WHERE thread_id IS NULL)
   UPDATE events e SET seq = r.s FROM r WHERE e.id = r.id AND e.seq <> r.s;
   DROP INDEX events_project_seq_idx;
   CREATE UNIQUE INDEX events_project_seq_idx ON events (project_id, seq) WHERE thread_id IS NULL;
   ```

   Renumbering is safe. Only thread topics replay from the log, and new seqs continue above every old maximum, so no client mistakes a new event for one it has seen. Generate the migration with `drizzle-kit generate` and append the `UPDATE` by hand.

### 2.2 One turn per thread

**Problem**

- `decide` lets `thread.send` through when `threads.status` is not `running`.
- The status only becomes `running` when the agent reactor appends `turn.started`, which happens after three DB reads (`agent.ts:340-477`).
- So two quick sends both pass and start two turns. Today only the global queue makes the window small; it doesn't close it.

**Design**

- The `user.message` projection claims the thread: `update threads set status = 'queued' where id = $1 and status in ('idle','error')`. If that updates 0 rows, throw a conflict. The transaction rolls back and the engine answers `conflict`.
- `decide` rejects `thread.send` while the thread is `queued`.
- New durable event `turn.dequeued { reason: "error" | "cancelled" | "restart" }`, projected as `status = 'idle'`.
- Every early `return` in `AgentReactor.#run` (missing thread, project or owner: `agent.ts:340-355`) appends it, so no thread is left `queued`.
- The boot reset (`index.ts:130`) also covers `queued`, appending `turn.dequeued { reason: "restart" }` per thread through `store.append` + `applyProjection`.
- Add `queued` to `ThreadSnapshot.status` (`packages/protocol`). The web's "working" checks include it (`apps/web/src/components/project-sessions-nav.tsx:78,126`).
- The chat renders a dequeued turn as "Stopped before it started" (`lib/chat-messages.ts`).

### Tests

- `engine.test.ts`: the projection statements for `user.message` (claim) and `turn.dequeued`, using the existing `recorder()` double.
- `decide.test.ts`: a send while queued gives `conflict`; a cancel while queued is accepted.
- New `eventstore.test.ts`, using a recording `tx` double like `engine.test.ts`: the lock statement is issued before `nextSeq`.
- `chat-messages.test.ts`: dequeued rendering.

### Acceptance

- Two `thread.send` frames 1 ms apart start exactly one turn.
- No duplicate `(project_id, seq)` exists (the unique index enforces it).

---

## 3. Warmup and boot (PF1.3, PF1.4)

**Decision:** shrink the warmup and drop the boot gate. This reverses the "whole app loads at boot" rule in `apps/web/CLAUDE.md` (commit `59d644f`). The same task rewrites that rule.

### Problem

- `lib/warmup.ts:58` sets `BUDGET = { projects: 20, sessionLists: 60, fileTrees: 5, hot: 5 }`. For each project, `warmupPlan` (`:111`) adds its open session plus every page in `PROJECT_PAGES` (`lib/sections.ts:382`), on top of the sections, the workspace-settings pages and the global pages.
- `lib/preload.ts:228` prefetches each one with `router.prefetch(href, { kind: FULL })`: about **117 full RSC renders per tab**, 4 at a time.
- `components/route-warmup.tsx` repeats the work:
  - a full re-warm after more than 4 min hidden (`:86`);
  - the hot set every 305 s while the tab is active (`:89`);
  - a full re-warm 2 s after anything calls `forgetPrefetched()` (`:95-99`).

  The only caller of `forgetPrefetched()` is the realtime bridge after a settings event (`lib/realtime.tsx:287`), so one member saving settings re-warms every member's tab.
- On the first page of a browser session the boot gate (`components/boot-gate.tsx`, cookie `ucch_warm`, `lib/boot-cookie.ts`) holds the app for up to `GATE_MS = 6000` while this runs.

### Design

- **Keep Next's default viewport prefetch.** `TransitionLink` passes no `prefetch` prop, so Next prefetches visible links down to the nearest `loading.tsx`, and every route has one. That is what makes a click paint the next page's skeleton in the same frame, and it is cheap: no data, no full render.
- **Stop FULL prefetches** for everything except the page about to open.
- **Warm data, not pages.** The query cache is persisted to IndexedDB (`lib/query-client.tsx`), so warmed data survives reloads without touching the server.
  - New budget: `{ projects: 3, sessionLists: 20, fileTrees: 1, hot: 0 }`.
  - Session lists stay generous: a few hundred bytes each, and B9's direct links need them.
- **Keep chunk warming** (`CHUNKS`, `lib/preload.ts:59`). It is static JavaScript served from disk with immutable caching, at no server cost.
- **Delete the re-warm triggers**: the visibility, hot-interval and `onForgotten` branches in `route-warmup.tsx`, and `forgetPrefetched` / `onForgotten` / `warmedAt` in `lib/preload.ts`.
- **Delete the boot gate**:
  - `components/boot-gate.tsx`, `lib/boot-cookie.ts`, `lib/boot-progress.ts`;
  - the `booted` prop and cookie read in `app/(app)/layout.tsx:27` and `AppShell`;
  - `forgetWarm()` in `nav-user.tsx`.
- **Simplify sign-in:** `components/boot-screen.tsx` becomes a plain transition to the destination. Keep `boot-frame.tsx` only if something else still uses it (today `login-form.tsx` does).
- **Rewrite the CLAUDE.md rule** as: "Every click paints a skeleton in the same frame (viewport prefetch to `loading.tsx`). Content is instant for the recent projects whose data the persisted cache holds; others show their skeleton until their data arrives. Never pre-render pages in the background."

### Risks

- Content for the 4th project onward shows a skeleton before content, instead of instantly. That is the trade, and it is visible in the product. Mitigate by prefetching data on hover (`onPointerEnter` → `queryClient.prefetchQuery` for that project's lists), which costs one small API call per hover, not a page render.
- `navigation.test.ts` and `preload.test.ts` assert today's behaviour and need rewriting.

### Tests

- `warmup.test.ts`: the new budget, and no FULL kind for any route except the current one.
- `preload.test.ts`: no re-warm after a refresh event, and the forgetting API is gone.
- `perf.spec.ts`: unchanged. It is the regression check for same-frame paint.

### Acceptance

- RSC requests for one fresh login (the proxy counter, §1) drop from ~117 to ≤ 15.
- A member saving settings causes 0 RSC requests in other members' tabs.
- `perf.spec.ts` nav-skeleton p95 is unchanged (≤ 100 ms).

---

## 4. `router.refresh()` → query invalidation (PF1.5–PF1.7)

### Problem

`router.refresh()` re-renders the whole RSC tree, including `AppShell`'s `getBootstrap()` and the page's own fetches. Through `forgetPrefetched` it also triggered the full re-warm in §3. It is called from 21 places. Two of them are fired by **other users' actions**, through realtime, so they turn into herds:

- `lib/realtime.tsx:286`: the CacheBridge refreshes on `resource.changed` for `account_settings` or `project_settings` (`lib/realtime-cache.ts`).
- `components/section-panel.tsx:112`: every fresh `project.stack_detected`, in every tab showing the dashboard.

Separately, `realtime-cache.ts` invalidates `qk.bootstrap` on `thread.created`, `agent.turn_completed` and `agent.turn_failed`. In a 50-member workspace, each finished turn causes about 50 bootstrap refetches.

### Design

**Seed + query.** Some data reaches the client only as RSC props. Give that data a client cache entry the same way bootstrap already has one (`lib/queries/bootstrap.ts`: `BootstrapSeed`, `useBootstrap`, `useShellLists`):

- `ProjectSeed` + `useProject(hash)`, key `qk.project(hash)`, fetching `/api/projects/{hash}`. Used by the project page's consumers and `project-chat.tsx`, so a project rename or preview-port change is an invalidation, not a re-render.
- `AppSidebar`'s user and `ViewerProvider`'s name read `useBootstrap().data.me` instead of `AppShell` props.

**Per call site.** Paths are under `apps/web/src/`.

| Site | Change |
|---|---|
| `lib/realtime.tsx:286` | Delete the refresh and `forgetPrefetched()`. `refreshPage` is gone from `cacheEffect`. `account_settings` → invalidate `[bootstrap]`. `project_settings` → `[tasks, bootstrap, project.all]` |
| `components/section-panel.tsx:112` | Invalidate `[bootstrap]` |
| `lib/use-new-session.ts:31`, `components/new-project-dialog.tsx:365` | Delete. `resource.changed{projects}` on the workspace topic already invalidates bootstrap |
| `components/session-list.tsx:53`, `components/file-explorer-toggle.tsx:143,153`, `components/project-chat.tsx:817`, `components/preview-dialog.tsx:118` | Invalidate `[bootstrap, sessions(hash), project(hash)]` |
| `components/new-database-dialog.tsx:136`, `components/database/connections-panel.tsx:100`, `components/database/connection-settings-dialog.tsx:95` | Invalidate `[bootstrap, connections]` |
| `components/account-settings.tsx:52` | Invalidate `[bootstrap]` |
| `components/workspace-switcher.tsx:97,335,349`, `components/invite-accept.tsx:33` | Invalidate `[bootstrap]`. The switcher's lists already come from `useShellLists` |
| `components/database/tables-column.tsx:73` | Invalidate the rows query if the grid is query-backed; otherwise keep (own tab, one render) |
| `components/nav-user.tsx:58` (logout) | `window.location.replace("/login")`: a hard navigation that drops all router state |
| `lib/workspace-context.tsx:58` (address names another workspace), `components/workspace-members-settings.tsx:307` (you left the workspace) | **Keep.** Own tab and rare; the shell genuinely changes |

**Herd smoothing** in the CacheBridge (`lib/realtime.tsx:272-311`):

- Bootstrap invalidations caused by turn edges use a trailing debounce of 3 s plus 0–2 s random jitter, not the 200 ms used for everything else.
- `refetchType: document.hidden ? "none" : "active"`: a hidden tab marks the data stale and refetches when it becomes visible.
- The sidebar doesn't wait for this. `useAgentActivity` already shows running and done from events (and from the workspace topic after §11).

### Risks

- A component reading a prop that used to be refreshed would show stale data. The grep test below catches new refreshes. A manual pass checks each converted site: rename, preview port, connection edit, profile change.

### Tests

- `realtime-cache.test.ts`: no event effect requests a page refresh, and turn edges are debounced.
- `navigation.test.ts`: a grep assertion that `lib/realtime*.tsx` contains no `router.refresh`.

### Acceptance

- 0 refreshes caused by realtime events.
- At most one bootstrap request per visible tab per 3 s from turn edges.

---

## 5. Bootstrap and `listProjects` (PF1.8, PF1.9)

### Problem

`GET /api/bootstrap` (`index.ts:708-752`) runs for every SSR render and every prefetch. In order, it runs:

- `resolveSession`;
- `ensureDefault` (which calls `workspaceService.list`);
- `getProfile`, `hasPassword` and `list` **again**;
- then `listProjects` and `databaseConnections.list`.

`listProjects` (`workspaces.ts:374-431`) repeats `canView` and runs five correlated subqueries per project:

- `running`: exists a thread with status `running`;
- `failed`: the latest turn across all threads, `order by turns.created_at desc limit 1`. `turns` has no `created_at` index, only the unique `(thread_id, seq)`;
- `threadCount`;
- two `SUM`s over every turn's JSONB `usage` and `cost_usd`.

Its cost grows with total history, not with activity. The ETag/304 (`:748-750`) is computed after all of that has already run.

### Design

**`project_stats`** is a separate narrow table rather than columns on `projects`. `projects` is read by every `#loadState` and updated on every container state change; keeping counter churn off it avoids row contention.

```sql
CREATE TABLE project_stats (
  project_id       uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  thread_count     integer          NOT NULL DEFAULT 0,
  tokens           double precision NOT NULL DEFAULT 0,
  cost_usd         double precision NOT NULL DEFAULT 0,
  last_turn_id     uuid,
  last_turn_failed boolean          NOT NULL DEFAULT false,
  updated_at       timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX threads_running_idx ON threads (project_id) WHERE status = 'running';
```

- **Backfill**, in the same migration: one `INSERT … SELECT` per project, using today's subqueries. The last turn comes from `LEFT JOIN LATERAL (… ORDER BY tu.created_at DESC LIMIT 1)`. The failed predicate is `error IS NOT NULL OR stop_reason IN (LIMIT_STOP_REASONS) OR stop_reason LIKE 'error%'`, with `LIMIT_STOP_REASONS` from `packages/protocol/src/events.ts:409`. Migrations run at boot before anything is served (`packages/db/src/bootstrap.ts`), so there are no concurrent writers.
- **`running` stays live:** an `EXISTS` on the new partial index. It is exact, can't drift, and needs no change to the boot reset (`index.ts:130`).
- **Projection** (`applyProjection`, `engine.ts:245`). Always relative SQL updates, never read-modify-write in JavaScript, because the agent reactor appends concurrently with the engine.

  | Event | Update |
  |---|---|
  | `project.created` | insert the row |
  | `thread.created` | `thread_count = thread_count + 1` (upsert) |
  | `turn.started` | `last_turn_id = turnId, last_turn_failed = false` |
  | `agent.turn_completed` | `tokens += input + output + cacheRead + cacheCreation`, `cost_usd += costUsd`, then `last_turn_failed = <failed predicate on the turns row> WHERE last_turn_id = turnId` |
  | `agent.turn_failed` | the same `last_turn_failed` update |

- **Deleting a thread** (`index.ts:1596`) is a raw delete that cascades to turns. Wrap it in a transaction with `recomputeProjectStats(tx, projectId)`, which is the backfill query for one project. A deleted session's spend disappears, as it does today.
- **`listProjects`** becomes `projects ⋈ workspaces ⟕ project_stats` (coalesce to 0) plus the `EXISTS` for `running`. Optionally, the workspace `stats` sums switch to `sum(project_stats.*)`.

**Bootstrap trim** (`index.ts:708`, `workspaces.ts`):

- `ensureDefault` takes the list it was given and only creates and re-lists when the user has no owned, live workspace. `list()` then runs once.
- `getProfile` and `hasPassword` become one select.
- `listProjects` accepts an already-checked permission and skips its own `canView`.
- About 8 queries become about 4.
- **No early ETag.** SSR's `getBootstrap` never sends `If-None-Match`, and an event-driven version counter could go stale silently. After `project_stats` the whole response takes a few milliseconds. Revisit only if PF3 shows bootstrap near the top of `pg_stat_statements`.

### Risks

- **Counter drift** if an event bypasses `applyProjection`. Every writer of `turns`/`threads` goes through it today; the delete path is the one exception and is handled above.
- **Backfill time** on large databases: one aggregate pass over `turns`, run once at boot.

### Tests

- `engine.test.ts`: the projection statements for each event above.
- A pure test of the failed predicate, sharing `LIMIT_STOP_REASONS`.

### Acceptance

- With 200 projects and 20,000 turns, bootstrap server time p95 < 15 ms.
- `EXPLAIN` shows no scan of `turns`.
- `listProjects` is not in the top 5 of `pg_stat_statements`.

---

## 6. Command path (PF1.10–PF1.12)

### Problem

- `OrchestrationEngine` (`engine.ts:39-127`) has one `DrainableWorker` (`worker.ts`) that runs every command from every user, one at a time.
- `ws.ts:157` starts each frame's handler without awaiting it, then awaits `engine.dispatch` and sends an `ack` per command (`ws.ts:193-210`).
- That includes every keystroke. `terminal.input` and `terminal.resize` carry only a `terminalId`, so `#loadState` does no DB reads for them, and `decide` passes them through (`decide.ts:355`). They still pay for:
  - waiting behind every other user's commands, including `thread.send` with its state loads and append transaction;
  - a zod `ClientFrame.parse` (`ws.ts:177`);
  - the `onDispatched` audit hook;
  - an `ack` frame;
  - a pending-promise entry in the browser.

### Design

**Terminal fast path**

- New client frames, without `id`:
  - `{ kind: "terminal_input", terminalId, data }` (`data` ≤ 64 KB);
  - `{ kind: "terminal_resize", terminalId, cols, rows }`.
- `ws.ts` recognises them before zod, with a prefix test on the raw string and then `typeof`/length checks.
- The handler checks `hasScope(principal.scopes, "exec")`, then calls new `TerminalReactor.input(terminalId, userId, data)` / `resize(...)`. That is today's `#mine` check plus `pty.write` (`terminals.ts:127-135`).
- No ack and no `onDispatched`. A refusal sends at most one rate-limited `error` frame.
- `dispatch terminal.*` keeps working for tabs loaded before the deploy.
- The client (`components/terminal-view.tsx:199,212`, `components/login-terminal-dialog.tsx:142,148`) calls new `client.terminalInput()` / `terminalResize()`, which don't create a pending promise.
- **Ordering.** Today `terminal.create` and the first keystrokes share one FIFO. On the fast path, input can arrive before the terminal has opened, and `#open` would drop it.
  - `TerminalReactor` keeps an early-input buffer, `Map<terminalId, { userId, chunks, bytes, at, size? }>`.
  - It accepts input only when the same user holds the claim. The client always subscribes, and so claims (`mayWatch`, `terminals.ts:170`), first.
  - Caps: 64 KB and 30 s.
  - `#open` flushes the buffer after spawn and applies the last size.

**Keyed engine queue**

- New `KeyedWorker<T>` in `worker.ts`: a `DrainableWorker` per key, created on demand and deleted when idle, behind a global semaphore `ENGINE_MAX_PARALLEL` (default 8, kept ≤ `DB_POOL_MAX − 4`). It exposes aggregate `outstanding`, `drain()` and `stop()`, so shutdown (`index.ts:3324`) is unchanged.
- Keys:

  | Command | Key |
  |---|---|
  | carries `projectId` | `p:<projectId>` |
  | carries `threadId` | `p:<access.projectOfThread(threadId)>` (cached; falls back to `t:<threadId>`) |
  | `project.create` | `w:<workspaceId>` |
  | `preview.delete` | `preview:<hash>` |

- **Per-connection order.** Resolving a key can need a DB read, so a later frame could otherwise overtake an earlier one. Each connection chains resolution: `conn.order = conn.order.then(resolveKey).then(key => queue.push(key, item))`.
- **Why per project, not per workspace.** In one shared workspace a per-workspace key collapses back to one global queue. Per-project keys are safe:
  - `decide` reads only the command's own thread, project, workspace and turn.
  - Membership changes only through REST (which calls `gateway.revalidate`), and REST and the reactors already write concurrently with the engine today.
  - Projections touch only same-project rows, plus `project_stats`, which uses relative updates.
  - Sequence allocation is protected by §2.1, and the one-turn rule by §2.2.
  - No command spans projects; `thread.fork` stays within one.
  - Reactors still run after commit, in per-key order.

**Optional:** merge `#loadState`'s thread → project → workspace + member lookups into one join (`engine.ts:129-220`), saving two round trips per command.

### Risks

- **Pool exhaustion** with many keys in flight. The semaphore bounds it below the pool size (§12).
- **Reordering across projects** is new, and intended. Nothing orders across projects today except by accident.

### Tests

- `worker.test.ts`: FIFO within a key; parallel across keys; the semaphore bound; `drain` waits for every key.
- `terminals.test.ts`:
  - early input is buffered, then flushed on open;
  - another user's early input is dropped;
  - the cap is enforced;
  - resize is applied on open.
- `ws` frame tests: the fast-path frames are accepted without an ack, malformed ones are refused, and the old `dispatch terminal.input` still works.

### Acceptance

- Under the 50-user load with turns streaming, keystroke echo p95 < 30 ms and p99 < 60 ms.
- Engine wait p99 < 20 ms.
- 0 `ack` frames for terminal input.

---

## 7. Token streaming and the chat (PF1.13–PF1.18)

### Problem

- **Server.** Every streamed chunk is one `agent.text_delta` / `agent.thinking_delta` event:
  - native turns: `packages/agent/src/loop.ts:263`, published through the `append` closure at `apps/server/src/agent.ts:364`;
  - Claude Code: `packages/providers/src/claude.ts:357`, routed through the same closure (`agent.ts:721-729`).

  Each event becomes one `bus.publish` (to `project:` and `thread:` topics, `bus.ts:90`) and one frame per subscriber.
- **Browser** (`lib/client.ts`):
  - every frame is `ServerFrame.parse`d with zod (`:297`);
  - deltas are not in `EPHEMERAL` (`:20`), so each one copies the 500-row event array (`:421`) and emits.

  **A long answer pushes the user's own messages and tool calls out of the 500-row window while it streams.** That is a correctness bug: they come back only on reload.
- **Chat** (`components/project-chat.tsx`). On every delta it:
  - filters all events by thread (`:615`);
  - loops them again for the worktree (`:629`);
  - rebuilds every message with `toMessages` (`:646`, `lib/chat-messages.ts:248`);
  - re-renders every `Message` (`:1872`, not memoized, with an inline ref callback at `:1239`);
  - re-parses the whole streaming answer's Markdown (`components/markdown.tsx:199`). The cost grows with the square of the answer length.
- **B8.** The chat opens its own socket (`project-chat.tsx:381`) because it renders from that client's 500-event history.

### Design

**Server coalescer** (new pure `apps/server/src/delta-coalescer.ts`, used inside the `append` closure in `AgentReactor.#run`, `agent.ts:364`; native, CLI and research turns all pass through it, so `loop.ts` and `claude.ts` don't change)

- `push(delta)` merges into the current run when the type and `turnId` match. Otherwise it starts a new run, so thinking and text keep their order.
- **Leading edge:** a turn's first delta is published immediately, so time-to-first-token doesn't change.
- **Trailing flush:** every `STREAM_FLUSH_MS` (40 ms), or at once when 2,048 characters are buffered.
- **Order:** every non-delta batch calls `flush()` first, then `store.append`. A transient-only append publishes synchronously (no `await` on that path), so the order on the wire is preserved.
- `finally` flushes and clears the timer.
- **Topic:** deltas go to `thread:` only (`bus.ts:90`). Nothing on a project topic reads them (`create-project.ts` waits only for `project.cloned`). This also stops a tab with both subscriptions getting them twice once B8 lands.

**Client data path**

- Add `agent.text_delta` and `agent.thinking_delta` to `EPHEMERAL` (`lib/client.ts:20`). This fixes the window-flooding bug.
- Batch `#emit` per animation frame, with a 100 ms timer fallback while the tab is hidden.
- Replace `ServerFrame.parse` on the hot path with `parseServerFrame`: `JSON.parse` plus a structural check of `kind`, `subscriptionId` and `event.type`. In development only, a dynamically imported zod check warns on mismatch.
- `ready` carries an optional `buildId`. A mismatch shows the update prompt (W5) or reloads.
- New `lib/thread-store.ts`: one store per thread, fed by `client.onEvent`, so pushes and acks both arrive.
  - **Durable layer:** rows sorted by seq, deduped by a `Set<seq>`, capped at `THREAD_WINDOW = 1000`. That is a new protocol constant shared with `REPLAY_LIMIT` (`ws.ts:20`), replacing the separate 500.
  - **Live layer:** `Map<turnId, runs[]>` of streaming text and thinking.
    - `agent.message` drops that turn's open text run.
    - `agent.turn_completed`, `agent.turn_failed` and `turn.dequeued` drop the turn.
    - `agent.queued` (§9) is held as live state.
  - **Versions:** `durableVersion` and `liveVersion`, read through `useSyncExternalStore` and notified at most once per frame.

**Chat render** (`components/project-chat.tsx`, `lib/chat-messages.ts`)

- Split `toMessages` into:
  - `toMessages(durable)`, memoized on `durableVersion`;
  - `overlayLive(messages, live)`, which clones only the active turn's message.
- Drop the per-delta `threadEvents` filter, since the store is already per thread. `worktree`, `promptHistory` and `neighbours` depend on durable data only.
- `Message` becomes `React.memo`. The inline ref callback becomes a stable per-message callback from a ref registry.
- New `StreamingMarkdown` for the active answer:
  - the prefix up to the last blank line outside a code fence renders through the memoized `Markdown` and doesn't change;
  - only the tail re-parses.

**B8: one socket per tab.** `project-chat.tsx` moves to the shared client (`useRealtime()`), with a reference-counted thread subscription and the thread store, and its own `new UcchClient()` is deleted. This depends on the topic change above, so a loud project subscription on the shared socket can't double the deltas.

**B11: bundle.**

- Add a `@ucch/protocol/plain` export: constants and helpers with no zod import, plus `"sideEffects": false`. Add a test that client code doesn't import runtime values from the barrel.
- Dropping `ServerFrame.parse` saves CPU, but not bundle size, as long as the barrel is imported. The web imports about 20 runtime helpers from `@ucch/protocol`, which builds its zod schemas when the module loads.
- B11's target becomes about −10%. The old −25% isn't reachable without replacing `@base-ui/react` (~82 kB).

### Risks

- **Lost deltas.** If the timer isn't flushed when a turn ends, the tail is lost. The `finally` flush and the flush before every durable event cover every exit.
- **A malformed frame reaching the UI.** The structural guard rejects frames without the fields the client reads, and the development zod check catches drift early.
- **Live layer stuck after a reconnect.** On resync, drop the live layer; the replay brings the durable `agent.message`.

### Tests

- `delta-coalescer.test.ts` (fake timers):
  - merging;
  - the leading edge;
  - flush before a durable event;
  - order across a type switch;
  - flush on dispose.
- `thread-store.test.ts`:
  - dedupe;
  - the window cap;
  - the live layer cleared on `agent.message` / `turn_completed`;
  - one notification per frame.
- `chat-messages.test.ts`: `overlayLive` on the existing fixtures produces the same output as today's interleaved-delta path.

### Acceptance

- A 2,000-token answer at 60 tokens/s sends at most a third of today's frames.
- On a 4,000-token answer, no long task over 50 ms while streaming, and INP < 200 ms.
- Earlier messages never disappear while an answer streams.
- One `/ws` per tab.

---

## 8. Replay and history (PF1.16, PF1.19)

### Problem

- A thread subscription replays up to 1,000 events, each as its own `send()` with its own `JSON.stringify` (`ws.ts:258-319`, `:292`).
- `threadHistory` (`eventstore.ts:137-168`) caches the **entire** history of the 32 most recent threads, with no size bound. Its only callers are the native turn context (`agent.ts:490`) and research (`:777`).

### Design

- **Batched replay.**
  - New server frame `{ kind: "replay", subscriptionId, events: [{ seq, at, projectId?, event }], done: boolean }`.
  - New `readThreadRaw` selects `payload::text`, so the server builds frames by string concatenation without parsing and re-serializing JSONB.
  - Chunks are at most 256 KB. Between chunks, the server waits while `bufferedAmount > 1 MB`, polling every 5 ms. `MAX_BUFFERED_BYTES` (16 MB, `ws.ts:552`) still terminates a stuck socket.
  - Buffered live events follow, deduped by seq as now.
  - Opt-in: the client connects with `&caps=replay1`, and without it the server replays one event per push as today. The client records a whole batch and emits once.
- **Bounded history.**
  - Replace the thread-count cap with a total-event cap, `HISTORY_CACHE_EVENTS` (default 20,000), evicting least-recently-used threads.
  - A thread larger than half the cap is returned but not cached.
  - A gauge reports the cached event count.

### Tests

- Replay chunking: frame size, ordering with live events buffered during the replay, and the old path without the capability.
- History eviction by total events, and the oversized thread not cached.

### Acceptance

- A 1,000-event replay arrives in ≤ 5 frames, with server p95 < 50 ms.
- API heap stays flat across 50 different thread opens.

---

## 9. Global caps (PF1.20–PF1.22)

### Problem

- The only agent limit is `AGENT_MAX_CONCURRENT_PER_USER` (default 2, `config.ts:140`), and only for CLI turns.
- It is checked after `turn.started` is appended and **throws**: the user gets a failed turn reading "Too many agents are running on your account" (`agent.ts:653-660`).
- Native turns have no limit, and there is no global limit. Fifty users can start about 100 Claude Code processes at 372 MB each.
- Terminals are capped only at 10 per project, hard-coded (`terminals.ts:35`).
- LibreOffice and Chromium jobs (the document kit) are unbounded.

### Design

**Turn scheduler** (new pure `apps/server/src/turn-scheduler.ts`)

- `acquire({ ownerId, kind: "cli" | "native", threadId, signal }) → release`.
- Limits:
  - `AGENT_MAX_CONCURRENT_PER_USER`: existing; CLI turns.
  - `AGENT_MAX_CONCURRENT_TOTAL`: new; CLI turns; default 5 (from the memory budget below).
  - `AGENT_MAX_NATIVE_TOTAL`: new; default 32. Diagram jobs count as native.
- Fairness: round-robin across users, so one user's ten queued turns don't block everyone else.
- `onChange(threadId, ahead)` publishes a transient `agent.queued { threadId, ahead }` to the thread topic. Add it to `TRANSIENT` (`packages/protocol/src/events.ts:773`), and re-send it on thread subscribe, the way composer state is sent.
- In `#run`, acquire after resolving the provider and **before** `turn.started`. While queued there is no `turns` row and nothing is billed. Delete the throw at `agent.ts:653-660`.
- Cancel while queued:
  - `decide` accepts `thread.cancel` when the status is `running` or `queued`;
  - aborting the controller rejects `acquire`;
  - the reactor appends `turn.dequeued { reason: "cancelled" }`.
- Web:
  - the composer shows "Queued — n ahead" with Stop;
  - the sidebar counts `queued` as working (`project-sessions-nav.tsx:78,126`);
  - the chat shows the queued state from the live layer (§7).

**Terminal caps.** Move these to `config.ts` and pass them in through `TerminalOptions`:

| Env | Default |
|---|---|
| `TERMINAL_MAX_PER_PROJECT` | 10 |
| `TERMINAL_MAX_PER_USER` | 5 |
| `TERMINAL_MAX_TOTAL` | 40 |
| `TERMINAL_IDLE_MINUTES` | 15 |

Terminals are interactive, so over the cap they refuse with a visible notice (via `#say`) instead of queueing.

**Heavy-job semaphore** (`packages/agent/src/executors/host.ts:99`, `HostExecutor.exec`)

- Classify commands by argv basename (`soffice`, `libreoffice`, `mmdc`, `chromium`), or by a path under `DOC_KIT_DIR`.
- Acquire `DOC_JOBS_MAX` (default 1), honouring the abort signal. The tool's timeout starts after acquisition.
- Claude Code's own bash tool can't be intercepted. §13's OOM priorities cover it.

**Memory budget for the defaults** (container limit 7 GB, §13)

| Consumer | Budget |
|---|---|
| Postgres (§12 tuning) | ~1.5 GB |
| API server | ~1.5 GB (heap limit) |
| Next.js | ~1.0 GB (heap limit) |
| MariaDB, if enabled | ~0.5 GB |
| CLI turns: 5 × ~0.4 GB | ~2.0 GB |
| **Total** | **~6.5 GB** |

Users' dev servers and terminals share what is left, plus whatever is unused above. That is why heavy children get a high OOM score (§13).

### Tests

- `turn-scheduler.test.ts`:
  - the per-user and total caps;
  - round-robin fairness;
  - abort while queued;
  - release on throw;
  - `ahead` counts.
- `decide.test.ts`: cancel while queued.
- `terminals.test.ts`: each cap refuses with a notice.

### Acceptance

- A burst of 20 CLI turns runs at most `AGENT_MAX_CONCURRENT_TOTAL` `claude` processes at once (resource sampler).
- The rest show as queued and run in turn. None fail with "Too many agents".

---

## 10. Shared git status (PF1.23–PF1.25)

### Problem

- `GitService.status` spawns 4 git processes (`git.ts:97-127`), and `GET …/git/status` adds an `isRepo` check.
- The web Git view (`components/git/use-git-state.ts:94-117`) fetches status, branches and the first log page in parallel, about 7 processes. It does so on mount, every 60 s while visible (`POLL_MS`, `:28`), and 300 ms after every `file.changed` / `git.committed` / `git.pushed` / `resource.changed{git}`.
- Every viewer of the same project repeats this. The view keeps its own state rather than a query, so cache invalidation can't help, and it refetches the selected diff after every status refresh even when nothing changed (`:200-215`).
- The file watcher (`file-watcher.ts`) ignores `.git`, so a commit from a terminal produces no event. It also doesn't watch session worktrees (`WORKSPACE_ROOT/.worktrees/<projectId>/<hash>`, `trees.ts:20-25`), and publishes one `file.changed` per path with no cap.

### Design

**Server cache** (new `apps/server/src/git-cache.ts`)

- Keyed by tree directory, holding `{ status, branches, log0, isRepo, version, at }`, with singleflight on computes in progress.
- Invalidated by:
  - watcher bursts;
  - git mutations in `git-routes.ts` (`announce`);
  - a `bus.tap` on `file.changed`, `git.committed` and `git.pushed`;
  - `.git` changes (below).
- 5 minutes' maximum age as a backstop. Nothing is recomputed until someone asks.
- After an invalidation, publish one transient `resource.changed { resource: "git", projectId }`, debounced 300 ms. **The status itself isn't pushed:** it can hold up to `MAX_STATUS_FILES` entries, and project topics reach every quiet subscriber.
- `GET git/status`, `git/branches` and `git/log?skip=0` read through the cache, with `ETag: <version>` and 304 support.

**Cheaper git** (`apps/server/src/git.ts`, `git-exec.ts`)

- `GIT_OPTIONAL_LOCKS=0` on read commands. `git status` then stops rewriting `.git/index`, which would otherwise wake the watcher again and contend with the agent for the index lock.
- Merge the two `rev-parse` calls into one (`--absolute-git-dir --is-shallow-repository`): 3 processes instead of 4.

**Watching** (`apps/server/src/file-watcher.ts`)

- A second subscription on `<root>/.git`, ignoring `objects/**`, `logs/**` and `*.lock`. Changes to `HEAD`, `index`, `refs/**`, `packed-refs`, `FETCH_HEAD` or `worktrees/*/{HEAD,index}` invalidate the checkout and that project's worktrees.
- Session worktrees are watched while a subscription names them: a new optional `tree: sessionHash` on the project subscribe topic.
- `file.changed` gains an optional `worktreeId`. This was the open part of R5, and `files-panel.tsx` filters by the tree it shows.
- Burst cap: above 200 paths in one burst, publish one `resource.changed { resource: "files", projectId, tree }` (new `LiveResource`) instead of one event per path.

**Web** (`components/git/use-git-state.ts`)

- Status, branches and log page 0 become `useQuery` with `staleTime: Infinity`, invalidated by `realtime-cache.ts` on `resource.changed{git}`, `git.committed` and `git.pushed`.
- `file.changed` no longer invalidates `qk.git.all`; the server sends one git invalidation per burst instead.
- Delete `POLL_MS`.
- Refetch the selected diff only when that file's entry in the status changes.

### Tests

- `git-cache.test.ts`: singleflight, invalidation, max age, version and 304.
- `file-watcher.test.ts` (temp directory): `.git` ignores, the burst cap, worktree retain/release.
- `realtime-cache.test.ts`: the new git and files mappings.

### Acceptance

- With 10 viewers on one project, one burst of file changes runs at most 3 git processes for that tree.
- No periodic git polling.
- A `git commit` in a terminal appears in the Git view within 1 s.

---

## 11. Subscription hygiene (PF1.26)

### Problem

- `useAgentActivity` (`lib/realtime.tsx:160-182`), the session list and the dashboard open a quiet `project` subscription for every listed project (`realtime.tsx:140,182,256`).
- `ws.ts:284-287` counts every project subscription, quiet ones included, as a file-watcher viewer. So every project in every open sidebar gets an inotify watch, and every burst in any of them fans out to every sidebar.
- A socket holds about P+3 subscriptions.

### Design

- The server publishes transient `project.activity { projectId, threadId, state: "running" | "done" | "failed" | "queued" | "idle" }` to `workspace:<id>`, derived in a `bus.tap` from turn edges and `turn.dequeued`, with a cached project → workspace map. Every shell already subscribes to its workspace topic (`realtime.tsx:75`).
- `useAgentActivity` and the session list read it from the workspace topic and drop the per-project quiet subscriptions.
- Only subscriptions with a new `files: true` flag call `onProjectWatch`. That flag is opt-in on `useProjectEvents`, for the Git view, files panel, code editor and the chat's file pane.

### Tests

- `ws` tests:
  - a quiet subscription no longer retains the watcher;
  - a `files: true` subscription does;
  - `project.activity` reaches workspace subscribers only.

### Acceptance

- About 4 subscriptions per socket, down from P+3.
- `watched_projects` equals the number of projects open in a view that shows files.

---

## 12. Runtime settings (PF1.27)

### Problem

- Neither Node process has a heap limit (`deploy/s6/s6-rc.d/{server,web}/run`).
- The DB pool is hard-coded at 10 (`packages/db/src/index.ts:24`).
- Every request is logged at info, including proxied static files and RSC.
- Postgres runs with small defaults.
- `NODE_OPTIONS` can't be used for heap limits: `terminalEnv` (`terminals.ts:423`) and `providerEnv` (`providers.ts:125`) pass the server's environment, minus secrets, to user shells, dev servers and CLIs.

### Design

- **Heap flags on the command lines:**
  - `server/run`: `node --max-old-space-size=${SERVER_HEAP_MB:-1536} --enable-source-maps /app/server/dist/server.mjs`
  - `web/run`: `node --max-old-space-size=${WEB_HEAP_MB:-1024} server.js`
  - Set each to about twice the peak heap measured in PF0. Too low gives an s6 restart loop.
- **`DB_POOL_MAX`** (default 20). `createDatabase(url, { max })` and `createClient(url, { max })` both take it; there are two pools. `ENGINE_MAX_PARALLEL` must stay ≤ `DB_POOL_MAX − 4`, and `loadConfig` rejects violations.
- **Logging:** `LOG_LEVEL` (pino levels; default `info` in production, `debug` otherwise) and `disableRequestLogging: true`. An `onResponse` hook logs only requests slower than `LOG_SLOW_MS` (1000) or returning 5xx.
- **Postgres defaults for an 8 GB box** (env-overridable in `postgres/run`):

  | Setting | Value | Why |
  |---|---|---|
  | `shared_buffers` | 1GB | was 256MB |
  | `effective_cache_size` | 3GB | planner hint |
  | `work_mem` | 8MB | unchanged; many connections |
  | `maintenance_work_mem` | 128MB | index builds, vacuum |
  | `max_connections` | 200 | users' dev servers share this Postgres |
  | `random_page_cost` | 1.1 | SSD |
  | `effective_io_concurrency` | 200 | SSD |
  | `jit` | off | short OLTP queries pay JIT startup for nothing |
  | `wal_compression` | on | |
  | `max_wal_size` | 2GB | fewer forced checkpoints |
  | `checkpoint_completion_target` | 0.9 | |
  | `idle_in_transaction_session_timeout` | 5min | stuck dev-server transactions |

- **README:** document every new variable under "Scaling".

### Acceptance

- Under the 50-user load: API RSS < 1.2 GB, no swap-in, cgroup `oom_kill` = 0.

---

## 13. Operations (PF2)

### Problem

- There is no CI.
- Dokploy builds the image on the production VPS, about 10 minutes with Next.js, while users are on it.
- There are no container limits, and nothing tells the kernel what to kill first.

### Design

**CI** (`.github/workflows/ci.yml`): pnpm install (cached), `pnpm typecheck && pnpm test`, `pnpm --filter @ucch/web build`, `node apps/web/scripts/bundle-budget.mjs --check`.

**Image** (`.github/workflows/image.yml`, on pushes to `main`)

- `docker/build-push-action` with `target: app`, `cache-from/cache-to: type=gha,mode=max`, and build arg `BUILD_ID=${{ github.sha }}`.
- Tags `ghcr.io/<owner>/ucch:<sha>` and `:main`.
- Then `curl -fsS -X POST "$DOKPLOY_DEPLOY_WEBHOOK"`.
- In Dokploy, switch the application's provider from Git + Dockerfile to **Docker image**: registry credentials (a `read:packages` token if the package is private) and its deploy webhook.
- `docker build .` keeps working locally; the Dockerfile is unchanged apart from deleting the deprecated `server` and `web` stages (`Dockerfile:141-172`). No compose file uses them.

**Limits**

- Dokploy → Advanced → Resources: memory limit 7168 MB, reservation 4096 MB, no CPU limit. Also set memory+swap equal to the memory limit if the Dokploy version exposes it.
- Child priorities: a shared helper prefixes argv with `choom -n ${CHILD_OOM_ADJ:-800} -- nice -n ${CHILD_NICE:-10} ionice -c2 -n7`, applied in:
  - `packages/providers/src/process.ts:113` (CLIs);
  - `packages/agent/src/executors/host.ts:99` (agent tools);
  - `apps/server/src/terminals.ts:242` (shells, with gentler values: `choom -n 500`, `nice 5`).
  - Not `runGit`, whose processes are short-lived.
- Raising a child's OOM score needs no privilege. That is enough for the kernel to kill a runaway dev server or CLI before the API or Postgres. Lowering the server's own score would need `CAP_SYS_RESOURCE`.
- At boot, check that `choom`, `nice` and `ionice` exist (all util-linux or coreutils, both present in bookworm). Fall back to the bare argv if not.
- **Not** `prlimit --as`: V8 reserves large virtual address ranges up front, so an address-space limit breaks Node children such as Claude Code.

**Alerts** (in-process watchdog over the sampler and metrics)

| Condition | For |
|---|---|
| cgroup `memory.current` > 85% of `memory.max` | 2 min |
| event-loop p99 > 200 ms | 1 min |
| `oom_kill` count increases | immediately |
| engine wait p99 > 500 ms | 1 min |

Each logs at error and POSTs JSON to `ALERT_WEBHOOK_URL` (ntfy or Slack-compatible), at most once per 15 min per condition. Prometheus and Grafana, as a Dokploy template scraping with `METRICS_TOKEN`, stay optional.

### Acceptance

- Deploys never compile on the VPS.
- A deliberately runaway dev server is OOM-killed before the API or Postgres.

---

## 14. Re-measure and the Rust decision (PF3)

- Re-run exactly the PF0 load profile and browser scenario. Write `documentation/perf/after-<date>.json` and a before/after table.
- Apply the checklist in `plan.md` §6, Phase 3:
  - API CPU above 50% of the container, or event-loop p99 above 50 ms;
  - API RSS above 1 GB, or GC visible in latency;
  - the remaining cost sits in the edge layer.
- Record the decision in `plan.md` §8. If it qualifies, the Rust edge daemon from `plan.md` §6 is the next project.

---

## 15. Work that continues after this plan

| Item | Relation to this plan |
|---|---|
| **R5 (rest):** `preview.published`, `port.opened`/`port.closed`, upload delete/attach events | After §11, so new broadcasts use the slimmer subscription model. `worktreeId` is now in §10 |
| **B11 (rest):** cmdk popovers behind `dynamic()`, split `FilesTree` out of `files-panel.tsx` | After the `plain` subpath (§7). Target −10% |
| **R8:** Hocuspocus co-editing server | After PF3. Run it as **its own s6 service and process**, with its own heap flag and an open-document limit, not inside the API's event loop. Measure it with the same load profile plus a co-editing scenario |
| **R9–R10:** notes, code and diagram co-editing | After R8 |
| **R11–R12:** per-field task mutations, DB-manager row conflicts | Independent of performance; can be done any time |
| **W1–W2:** manifest, static root layout | Any time. W2 reduces SSR work |
| **W3–W5:** service worker, offline page, update prompt | After §3. A service worker caching `/_next/static` replaces what remained of chunk warming |

---

## Appendix A: new environment variables

| Variable | Default | Section |
|---|---|---|
| `METRICS_TOKEN` | unset (loopback only) | §1 |
| `LOG_RESOURCE_SAMPLES` | `false` | §1 |
| `PG_LOG_MIN_DURATION_MS` | `500` | §1 |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | §1 |
| `LOADTEST_ALLOW_SEED` | unset | §1 (seed script only) |
| `ENGINE_MAX_PARALLEL` | `8` | §6 |
| `STREAM_FLUSH_MS` | `40` | §7 |
| `HISTORY_CACHE_EVENTS` | `20000` | §8 |
| `AGENT_MAX_CONCURRENT_TOTAL` | `5` | §9 |
| `AGENT_MAX_NATIVE_TOTAL` | `32` | §9 |
| `TERMINAL_MAX_PER_PROJECT` / `_PER_USER` / `_TOTAL` | `10` / `5` / `40` | §9 |
| `TERMINAL_IDLE_MINUTES` | `15` | §9 |
| `DOC_JOBS_MAX` | `1` | §9 |
| `SERVER_HEAP_MB` / `WEB_HEAP_MB` | `1536` / `1024` | §12 |
| `DB_POOL_MAX` | `20` | §12 |
| `LOG_LEVEL` / `LOG_SLOW_MS` | `info` / `1000` | §12 |
| `PG_*` (see the table) | | §12 |
| `CHILD_OOM_ADJ` / `CHILD_NICE` | `800` / `10` | §13 |
| `ALERT_WEBHOOK_URL` | unset | §13 |

## Appendix B: protocol and data changes

| Change | Kind | Compatibility |
|---|---|---|
| `terminal_input`, `terminal_resize` client frames | new frames | old `dispatch terminal.*` still accepted |
| `replay` server frame | new frame | only with `caps=replay1` |
| `ready.buildId` | optional field | ignored by old clients |
| `agent.queued`, `project.activity` | new transient events | old clients ignore unknown events |
| `turn.dequeued` | new durable event | renders as a stopped turn |
| thread status `queued` | new enum value | old clients treat it as not working; harmless |
| `file.changed.worktreeId`, `resource.changed{files}` | optional field, new resource | additive |
| project subscribe `tree`, `files` | optional fields | additive |
| deltas on `thread:` topic only | routing | nothing on project topics reads them |
| `THREAD_WINDOW = 1000` | constant | replaces the client's 500 |

## Appendix C: migrations

| # | Name | Contents |
|---|---|---|
| 0025 | `event_stream_seq` | renumber project-scoped seqs; unique partial index |
| 0026 | `project_stats` | table, backfill, `threads_running_idx` |

## Appendix D: file index

| Area | Files |
|---|---|
| Metrics | `apps/server/src/{metrics,resource-sampler}.ts` (new), `index.ts`, `web-proxy.ts`, `ws.ts`, `engine.ts`; `apps/web/src/components/vitals-reporter.tsx` (new) |
| Load | `scripts/load/{run,mock-openrouter,fake-claude}.mjs` (new), `apps/server/scripts/seed-load.ts` (new), `scripts/pg-top.sh` (new) |
| Correctness | `apps/server/src/{eventstore,engine,decide,agent,index}.ts`, `packages/db/src/schema.ts`, `packages/protocol/src/events.ts` |
| Warmup / refresh | `apps/web/src/lib/{warmup,preload,realtime,realtime-cache}.ts(x)`, `components/{route-warmup,boot-gate,boot-screen,section-panel}.tsx`, `app/(app)/layout.tsx`, `apps/web/CLAUDE.md` |
| Bootstrap | `apps/server/src/{workspaces,index,engine}.ts`, `packages/db/src/schema.ts` |
| Command path | `apps/server/src/{worker,engine,ws,terminals}.ts`, `apps/web/src/lib/client.ts`, `components/{terminal-view,login-terminal-dialog}.tsx` |
| Streaming | `apps/server/src/{delta-coalescer,agent,bus}.ts`, `apps/web/src/lib/{client,thread-store,chat-messages}.ts`, `components/{project-chat,markdown}.tsx`, `packages/protocol/package.json` |
| Caps | `apps/server/src/{turn-scheduler,agent,config,terminals}.ts`, `packages/agent/src/executors/host.ts` |
| Git | `apps/server/src/{git-cache,git,git-exec,git-routes,file-watcher}.ts`, `apps/web/src/components/git/use-git-state.ts`, `lib/realtime-cache.ts` |
| Runtime / ops | `deploy/s6/s6-rc.d/{server,web,postgres}/run`, `packages/db/src/index.ts`, `.github/workflows/{ci,image}.yml` (new), `Dockerfile`, `README.md` |
