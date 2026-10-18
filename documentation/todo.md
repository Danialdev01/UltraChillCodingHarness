# UCCH: agent task list

Source of truth for *why*: [`plan.md`](./plan.md). This file is *what to do*, in order.

## How to use this file (read first)

1. **Pick a task.** Take the lowest-numbered unchecked task in the earliest phase whose **Depends** are all checked. Don't start a task whose dependencies are open.
2. **Read before writing.** Read every file under **Files**, and the plan section the task cites. Many tasks reuse existing code; the task names it.
3. **Stay in scope.** One task is one coherent change. Don't refactor neighbouring code, rename unrelated things or reformat files.
4. **Follow the conventions:**
   - `apps/web/CLAUDE.md`: skeletons not spinners, `TransitionLink` / `useTransitionRouter` only, layouts await nothing, a `loading.tsx` per route.
   - Match the surrounding code's comment density and naming. Server modules use `#private` fields and explanatory block comments.
   - Tests sit next to the code (`*.test.ts`) and run with vitest from the repo root.
5. **Verify.** Run every command under **Verify**. A task is done only when they all pass *and* every **Acceptance** bullet holds.
6. **Record it.** Change `[ ]` to `[x]` and add ` — <commit sha>` after the title. Commit messages end with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
7. **If blocked:** leave the task unchecked and add a `> BLOCKED:` line under it saying why. Then move to another task with no dependency on it.

Standard verification, for any task that touches code:
```bash
pnpm typecheck && pnpm test
# web tasks also need a production build — next dev does not prefetch
pnpm --filter @ucch/web build
```

---

## Phase P0: Baseline

- [x] **P0.1 — Checkpoint the working tree** — aa4d8ee
  - **Depends:** —
  - **Files:** whole repo (`git status`)
  - **Steps:**
    1. **Ask the human first.** The tree holds about 250 uncommitted changes they made.
    2. With approval, create branch `perf/single-container`, then commit the current state as `chore: checkpoint before perf/realtime work`.
  - **Acceptance:** `git status` is clean on the new branch.
  - **Verify:** `git status --short | wc -l` → `0`

- [x] **P0.2 — Fix `runDiagramJob` undefined `tree`** — fix(server): runDiagramJob
  - **Depends:** P0.1
  - **Files:** `apps/server/src/index.ts` (`runDiagramJob`, around line 1855), `apps/server/src/files.ts`, `apps/server/src/worktrees.ts`, `apps/server/src/diagrams.test.ts`
  - **Steps:**
    1. Find how other call sites in `index.ts` resolve the `tree` argument for `workspaceFiles.write`. It's the project's main tree; HEAD passed `project.id`.
    2. Resolve it the same way inside `runDiagramJob`.
    3. Add a regression test if the function can be reached from a test; otherwise rely on typecheck.
  - **Acceptance:** `pnpm typecheck` has no error about `tree`. Generating a diagram writes the file.
  - **Verify:** `pnpm typecheck && pnpm test`

- [x] **P0.3 — Playwright harness + perf baseline** — baseline in apps/web/e2e/results/{baseline,bundle-baseline}.json
  - **Depends:** P0.1
  - **Files:**
    - new `apps/web/e2e/` and `apps/web/playwright.config.ts`
    - `apps/web/package.json` (devDependency `@playwright/test`, script `e2e`)
    - `.env.development.example` (`DEV_AUTH_BYPASS`)
  - **Steps:**
    1. Configure Playwright to start `pnpm --filter @ucch/server start` and `pnpm --filter @ucch/web build && pnpm --filter @ucch/web start` with `DEV_AUTH_BYPASS=1` and `NODE_ENV=development` for the server. Copy the cookie approach from `README.md`.
    2. Write `e2e/perf.spec.ts`. It visits login → shell → project → session A → session B → tasks → documentation → note A → note B → settings page 1 → settings page 2.
    3. For each click it records:
       - time to the first frame where the old page is gone (skeleton or new page), via `performance.now()` around the click and a `requestAnimationFrame` poll for the `data-page` marker
       - time to content
    4. Write the results to `apps/web/e2e/results/baseline.json`, which is git-ignored except for a committed `baseline.json`.
    5. Record first-load JS per route from the `next build` output into the same file.
  - **Acceptance:** `pnpm --filter @ucch/web e2e` runs headless and writes the baseline. The numbers are pasted into the "Baseline" column of the [Definition of Done](#definition-of-done) table.
  - **Verify:** `pnpm --filter @ucch/web e2e`

---

## Phase S: Realtime security (before any new broadcast)

- [x] **S1 — Terminal output only on the terminal topic**
  - **Depends:** P0.1
  - **Files:** `apps/server/src/bus.ts` (`publish`), `apps/server/src/index.ts` (terminal output publisher, around line 340), `apps/server/src/terminals.ts`, `apps/web/src/components/terminal-view.tsx`, `apps/web/src/components/login-terminal-dialog.tsx`
  - **Steps:**
    1. Publish `terminal.output` **only** to `terminal:{id}`, not to `project:{id}`. Other terminal lifecycle events (opened/closed) can stay on the project topic.
    2. Make sure every client consumer of terminal output subscribes to the `terminal` topic.
    3. Add a test in `bus` or `ws` tests: a project subscriber does not receive `terminal.output`.
  - **Acceptance:** A second member viewing the project receives no terminal bytes. Terminals still work for their owner.
  - **Verify:** `pnpm test -- bus ws terminals`

- [x] **S2 — ACL on `subscribe(terminal)`**
  - **Depends:** S1
  - **Files:** `apps/server/src/ws.ts` (subscribe handler, around line 220), `apps/server/src/terminals.ts` (owner lookup, `#mine`)
  - **Steps:**
    1. On a `terminal` subscribe, look up the terminal's owner. Reject with an `error` push unless the subscriber is the owner.
    2. Test both allow and deny.
  - **Acceptance:** Subscribing to another user's terminal id fails.
  - **Verify:** `pnpm test -- ws terminals`

- [x] **S3 — Revoke cached access and subscriptions**
  - **Depends:** S1
  - **Files:** `apps/server/src/ws.ts` (cached access, around line 391), `apps/server/src/access.ts`, `apps/server/src/workspace-members-routes.ts`, `apps/server/src/workspaces.ts`, project delete in `index.ts`, `packages/protocol/src/rpc.ts`
  - **Steps:**
    1. Add `WebSocketGateway.revoke({ userId?, projectId?, workspaceId? })`. It clears matching access-cache entries and force-unsubscribes affected topics on matching connections.
    2. It also sends a new `push` of kind `subscription.revoked {topic}`; add the type to the protocol.
    3. Call it on: member removed, member role changed to none, project deleted, workspace deleted.
    4. On logout (`auth.ts` session delete), close all of that user's sockets.
    5. Client (`lib/client.ts`): on `subscription.revoked`, drop the subscription locally and do not resubscribe.
    6. Test it.
  - **Acceptance:** A removed member stops getting project events immediately, without reconnecting.
  - **Verify:** `pnpm test -- ws workspace-members`

- [x] **S4 — Security regression tests**
  - **Depends:** S1–S3
  - **Files:** new `apps/server/src/realtime-acl.test.ts`
  - **Steps:** One test file with these scenarios, using the existing `ws` test helpers:
    - a non-member can't subscribe to a project
    - a member can't read another member's terminal
    - a removed member is cut off
    - a logged-out user's socket is closed
  - **Acceptance:** All scenarios pass.
  - **Verify:** `pnpm test -- realtime-acl`

---

## Phase D: Single container

- [x] **D1 — Precompile the server**
  - **Depends:** P0.1
  - **Files:** new `apps/server/build.mjs`, `apps/server/package.json` (`build` script, `esbuild` devDependency), `packages/db/src/bootstrap.ts` (migrations path)
  - **Steps:**
    1. Bundle `apps/server/src/index.ts` with esbuild into `apps/server/dist/server.mjs`: `platform=node`, `target=node22`, `format=esm`, `bundle`, `sourcemap=linked`.
    2. Keep these external: `@lydell/node-pty`, `postgres`, `mysql2` and any package esbuild can't bundle (dynamic requires).
    3. Add the `createRequire` banner for CJS deps.
    4. Make the migrations folder resolvable from the bundle: accept `MIGRATIONS_DIR` env, defaulting to the current relative path.
    5. `node apps/server/dist/server.mjs` must boot locally against the dev Postgres.
  - **Acceptance:** `pnpm --filter @ucch/server build` produces the bundle, the server boots from it and `/health` answers. `tsx` is no longer needed at runtime.
  - **Verify:** `pnpm --filter @ucch/server build && node apps/server/dist/server.mjs` (with `.env` loaded), then `curl localhost:3001/health`

- [ ] **D2 — Edge proxy: the server serves the one public port**
  - **Depends:** D1
  - **Files:**
    - new `apps/server/src/web-proxy.ts` and `web-proxy.test.ts`
    - `apps/server/src/index.ts` (`serverFactory`, upgrade handler around line 3063, compress registration)
    - `apps/server/src/config.ts` (`WEB_UPSTREAM`, `WEB_STATIC_DIR`)
    - `apps/server/package.json` (`undici`)
  - **Steps:**
    1. Add the config: `WEB_UPSTREAM` (e.g. `http://127.0.0.1:3100`) and `WEB_STATIC_DIR` (the `.next/static` path). When `WEB_UPSTREAM` is unset, behaviour is exactly as today.
    2. Order in `serverFactory`:
       - a. preview host (unchanged)
       - b. `/api/*`, `/health`: Fastify
       - c. `/_next/static/*`: stream the file from `WEB_STATIC_DIR` with `Cache-Control: public, max-age=31536000, immutable`, correct `Content-Type`, and `404` for misses
       - d. anything else: proxy
    3. The proxy uses an undici `Pool` (keep-alive) and **streams** the body both ways. It forwards the method, path, query, headers (except hop-by-hop), `x-forwarded-for`/`-proto`/`-host` and the original `Host`. It copies the status and headers back, including multiple `set-cookie`.
    4. On an upstream error, return a minimal `502` HTML page with `Cache-Control: no-store`.
    5. Upgrades: `/ws` goes to the existing gateway, preview hosts to the preview gateway, and any other path gets a 404 (as today). `/collab` comes later in R8.
    6. Make sure `@fastify/compress` does not touch proxied responses.
    7. Tests with a fake upstream:
       - streaming (a chunk arrives before the upstream ends)
       - `set-cookie` passthrough
       - `502` on a dead upstream
       - immutable static headers
       - `/api` never proxied
  - **Acceptance:** With `next start -p 3100` and the server on 3000, the whole app works through `http://localhost:3000`: login, navigation, chat streaming, terminals, previews. Suspense fallbacks still stream.
  - **Verify:** `pnpm test -- web-proxy`, plus a manual run as above

- [ ] **D3 — Extend `/health`**
  - **Depends:** D2
  - **Files:** `apps/server/src/index.ts` (`/health`, around line 607)
  - **Steps:** Add `db` (`select 1`, 1 s timeout) and `web` (`HEAD ${WEB_UPSTREAM}/healthz`, 1 s timeout, only when the upstream is set). Return HTTP `503` when either fails. Keep the existing fields.
  - **Acceptance:** Stopping Next makes `/health` return 503 with `web: "error"`.
  - **Verify:** manual curl

- [ ] **D4 — s6-overlay service tree**
  - **Depends:** D1
  - **Files:** new `deploy/s6/s6-rc.d/{init-dirs,init-secrets,postgres,mysql,web,server,user}/…`, new `deploy/s6/scripts/*.sh`; reuse the logic of `deploy/secrets.sh`, `deploy/server-entrypoint.sh`, `deploy/postgres-init.sh`, `deploy/mysql-init.sql`
  - **Steps:**
    1. `init-dirs` (oneshot, root): create `/data/{postgres,mysql,workspaces,creds,secrets,backups}`.
       - Owners: postgres:postgres for `postgres`; mysql:mysql for `mysql`; node:node for `workspaces` and `creds`; root for `secrets` and `backups`.
       - Mode 0700 except `workspaces`.
       - Chown only when the top-level owner is wrong (as in `server-entrypoint.sh`).
    2. `init-secrets` (oneshot, root): port `secrets.sh` to write into `/data/secrets`. An env value wins; otherwise generate only when missing. Same names. `postgres_password` is readable by the postgres user only. The dev DB password file is readable by `node` (projects need it, as today).
    3. `postgres` (longrun):
       - If `DATABASE_URL` is set, `exec s6-svc -O .` (don't restart) and sleep forever.
       - Otherwise, on first run with no `PG_VERSION`: `initdb -D /data/postgres --auth=scram-sha-256 --pwfile`, then a temporary start to run the SQL from `postgres-init.sh` (ucch role and db, dev role and db, revoke), then stop.
       - Run `postgres -D /data/postgres -c listen_addresses=127.0.0.1 -c shared_buffers=${PG_SHARED_BUFFERS:-256MB} -c effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE:-768MB} -c work_mem=${PG_WORK_MEM:-8MB}`.
       - Readiness with `notification-fd` and a `pg_isready` loop.
    4. `mysql` (longrun): run only if `ENABLE_MYSQL=true` and `DEV_MYSQL_URL` is unset. `mariadb-install-db` on first run, `--bind-address=127.0.0.1`, apply `mysql-init.sql` (and create the `dev` user with the dev password) once. Readiness through `mariadb-admin ping`.
    5. `web` (longrun, user node): `HOSTNAME=127.0.0.1 PORT=3100 NODE_ENV=production node /app/apps/web/server.js`.
    6. `server` (longrun): the env assembly from `server-entrypoint.sh`:
       - `DATABASE_URL` defaults to `postgres://ucch:<pw>@127.0.0.1:5432/ucch`.
       - `DEV_POSTGRES_URL` defaults to `…@127.0.0.1:5432/dev`.
       - `DEV_MYSQL_URL` defaults only when mysql is enabled.
       - `PORT=3000`, `WEB_UPSTREAM=http://127.0.0.1:3100`, `WEB_STATIC_DIR=/app/apps/web/.next/static`, `WORKSPACE_ROOT=/data/workspaces`, `CREDS_ROOT=/data/creds`, `MIGRATIONS_DIR`.
       - Then `exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs node /app/apps/server/dist/server.mjs`.
       - Depends on postgres, mysql and web.
    7. Set `S6_KILL_GRACETIME=60000`, `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, `S6_CMD_WAIT_FOR_SERVICES_MAXTIME=120000`.
  - **Acceptance:** In the container (D5), the services start in order and `docker stop` drains the server within 60 s. With `DATABASE_URL` set, no postgres process runs.
  - **Verify:** covered by D9

- [ ] **D5 — Dockerfile `app` stage**
  - **Depends:** D1, D4
  - **Files:** `Dockerfile`, `.dockerignore`
  - **Steps:**
    1. Add a `server-build` stage: `pnpm install --filter @ucch/server...`, run the esbuild build, then `pnpm deploy --filter @ucch/server --prod /out/server` (or install production externals only).
    2. Add the final `app` stage from `node:22-bookworm-slim`:
       - The same apt toolchain as today's `server` stage, plus the PGDG repo with `postgresql-16`, plus `mariadb-server`.
       - s6-overlay v3 noarch + x86_64 tarballs (pinned `ARG S6_OVERLAY_VERSION`).
    3. Copy in:
       - the Next standalone output to `/app` (keeping `apps/web/server.js`), and `.next/static` to `/app/apps/web/.next/static`
       - the server bundle and externals
       - `packages/db/migrations`
       - `packages/agent/doc-kit`
       - `deploy/s6` to `/etc/s6-overlay`
    4. `ENTRYPOINT ["/init"]`, `EXPOSE 3000`, `VOLUME /data`, `HEALTHCHECK … curl -fsS http://127.0.0.1:3000/health`.
    5. Keep the old `server` and `web` targets building for one release, with a deprecation comment.
    6. Build args stay: `NEXT_PUBLIC_TLDRAW_LICENSE_KEY`. Set `SERVER_ORIGIN=http://127.0.0.1:3000` and `NEXT_PUBLIC_WS_ORIGIN=""` for the web build.
  - **Acceptance:** `docker build --target app -t ucch .` succeeds. The image size is recorded in the PR.
  - **Verify:** `docker build --target app -t ucch . && docker image ls ucch`

- [ ] **D6 — Container isolation check**
  - **Depends:** D5
  - **Files:** `deploy/s6/scripts/*`, `apps/server/src/terminals.ts`, the agent bash executor in `packages/agent/src/executors/`
  - **Steps:** Inside a running container, as `node`:
    1. Confirm that `cat /data/secrets/*`, `ls /data/postgres` and `ls /data/mysql` fail.
    2. Confirm that `env` inside a terminal and inside the agent bash shows no `DATABASE_URL` or `SECRET_KEY`. If either leaks, strip it in the spawn env.
    3. Confirm that `psql -h 127.0.0.1 -U dev ucch` is refused.
  - **Acceptance:** All checks hold. Add them as assertions in the D9 smoke script.
  - **Verify:** D9

- [ ] **D7 — Single-service `docker-compose.yml` + env docs**
  - **Depends:** D5
  - **Files:** `docker-compose.yml`, `.env.example`, `.env.development.example`
  - **Steps:**
    1. Replace the six services with one `ucch` service: build target `app`, port `3000`, volume `ucch-data:/data`, the env list, healthcheck.
    2. Keep the Traefik labels as a commented example only.
    3. In `.env.example`, document `ENABLE_MYSQL`, `PG_*` tuning, external `DATABASE_URL`/`DEV_*_URL`, and `CRAWL4AI_URL`. Remove `WEB_REPLICAS` and `COMPOSE_PROFILES`.
  - **Acceptance:** `docker compose up` brings the app up on :3000.
  - **Verify:** `docker compose up -d && curl -fsS localhost:3000/health`

- [ ] **D8 — Backup / restore scripts**
  - **Depends:** D5
  - **Files:** new `deploy/bin/ucch-backup`, `deploy/bin/ucch-restore` (installed to `/usr/local/bin`)
  - **Steps:**
    1. `ucch-backup`: `pg_dump -Fc` of `ucch` and `dev` into `/data/backups/<ts>/`, plus a copy of `/data/secrets/secret_key`. Prune to the last N (`BACKUP_KEEP`, default 7).
    2. `ucch-restore <dir>`: stop the server through `s6-svc -d`, then `pg_restore --clean`, then start the server again.
  - **Acceptance:** A backup restored into a fresh container keeps users, projects and decrypted keys.
  - **Verify:** manual round trip, documented in the PR

- [ ] **D9 — Container smoke test**
  - **Depends:** D2–D8
  - **Files:** new `scripts/smoke-container.sh`
  - **Steps:** The script does the following and exits non-zero on any failure:
    1. Builds the image.
    2. Runs it with `-e ROOT_DOMAIN=localhost -e DEFAULT_USER_PASSWORD=… -v` (temporary volume) `-p 3000`.
    3. Waits for `/health` to return 200.
    4. Logs in through `/api/auth/login`, then `GET /` returns 200 HTML, a `/_next/static/*` asset has the immutable header, and a `/ws` upgrade succeeds (node `ws`).
    5. Runs the D6 isolation checks with `docker exec -u node`.
    6. `docker stop` within 60 s.
    7. Restarts and confirms the data persists.
    8. Repeats with `ENABLE_MYSQL=true` and checks that `mariadb-admin ping` succeeds.
  - **Acceptance:** The script passes locally. It's referenced from the README.
  - **Verify:** `bash scripts/smoke-container.sh`

- [ ] **D10 — README: deploying on Dokploy (single container) + migration guide**
  - **Depends:** D7, D8
  - **Files:** `README.md` ("Deploying on Dokploy" section, layout table, status table; fix the `/login` versus `/healthz` mismatch)
  - **Steps:**
    1. Rewrite the section from plan.md §A.6: Application, Dockerfile, target `app`, port 3000, `/data` volume, **Swarm update order stop-first** in bold, the optional wildcard preview domain and the Traefik file-provider fallback snippet.
    2. Add a "Migrating from the multi-container stack" section from plan.md §A.7, with `SECRET_KEY` carry-over in bold.
    3. Update the env table.
    4. Remove `apps/gateway`, `packages/runtime` and `packages/vcs` from the layout table, or mark them "planned".
  - **Acceptance:** Someone can deploy from the README alone.
  - **Verify:** read-through. Every command in it was run in D9.

---

## Phase B (core): Instant navigation

- [ ] **B1 — `GET /api/bootstrap` + hash-addressed reads**
  - **Depends:** P0.1
  - **Files:**
    - `apps/server/src/index.ts`, or new `apps/server/src/bootstrap-routes.ts` registered from it
    - `apps/server/src/workspaces.ts`, `apps/server/src/access.ts`
    - `packages/protocol` (response type)
    - `packages/db/migrations` (indexes, if needed)
  - **Steps:**
    1. One handler that authenticates once, then in parallel:
       - user and preferences
       - workspaces (with role)
       - the active workspace (`?ws=` hash, then the cookie hint, then the first)
       - its projects and DB connections
       - quotas (optional, short timeout; omitted on timeout)
       - the `buildId` (env `BUILD_ID`, else the package version)
    2. Strong `ETag` over the JSON. Answer `If-None-Match` with `304`.
    3. Add `GET /api/workspaces/by-hash/:hash` and make sure `GET /api/projects/:hash` exists and returns the summary.
    4. Run `EXPLAIN ANALYZE` on each query against a seeded DB and add indexes in a new migration if any are sequential scans. Generate the migration with `pnpm db:generate`.
    5. Tests: shape, 401, 304, active-workspace fallback.
  - **Acceptance:** One request returns all shell data. p95 is under 50 ms locally with 20 projects.
  - **Verify:** `pnpm test -- bootstrap`

- [ ] **B2 — Middleware cookie gate**
  - **Depends:** P0.1
  - **Files:** `apps/web/src/middleware.ts`
  - **Steps:**
    1. For app routes (not `/login`, `/shared`, `/invite` landing, `/healthz`, `/_next`, `/file-icons` or public slugs), redirect to `/login?next=<path>` when `ucch_session` is **absent**. Do no network call.
    2. Keep the existing rewrite, legacy redirect and workspace header behaviour.
    3. Add a unit test for the matcher logic if it's extracted into a pure function.
  - **Acceptance:** A signed-out visit to `/abc…/code` lands on `/login?next=…` without an API call.
  - **Verify:** `pnpm test`, plus manual

- [ ] **B3 — TanStack Query provider + IndexedDB persistence**
  - **Depends:** B1
  - **Files:**
    - new `apps/web/src/lib/query-client.tsx`, new `apps/web/src/lib/query-keys.ts`
    - `apps/web/src/components/app-shell.tsx`
    - `apps/web/package.json` (`@tanstack/react-query`, `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`, `idb-keyval`, pinned exact)
  - **Steps:**
    1. Create a `QueryClient` with defaults: `staleTime` 30 s, `gcTime` 24 h, `retry` 1 for queries and 0 for mutations, and `refetchOnWindowFocus`.
    2. Wrap it in `PersistQueryClientProvider`:
       - IndexedDB storage, key `ucch-cache:<userId>`
       - `buster: buildId`
       - `dehydrateOptions.shouldDehydrateQuery: q => q.meta?.persist === true && q.state.status === "success"`
       - `maxAge` 7 days
    3. Wrap every storage access in try/catch; private mode must still work, with no persistence.
    4. In `query-keys.ts`, a key factory per domain: `workspaces`, `projects`, `connections`, `sessions`, `tasks`, `timeline`, `notes`, `noteTree`, `keys`, `activity`, `members`, `git`, `files`, `quotas`, `bootstrap`.
    5. Provide `clearUserCache()`. Call it from logout (`nav-user.tsx`) and when bootstrap returns a different user id.
  - **Acceptance:** Reloading an app page shows cached data before the network answers (check with DevTools throttling). Logging out empties the IndexedDB store.
  - **Verify:** `pnpm typecheck && pnpm --filter @ucch/web build`

- [ ] **B4 — Streaming, non-blocking `AppShell`**
  - **Depends:** B1, B3
  - **Files:**
    - `apps/web/src/components/app-shell.tsx`, `app-sidebar.tsx`, `app-header.tsx`
    - `apps/web/src/lib/session.ts`
    - `apps/web/src/components/page-skeletons.tsx` (new `SidebarSkeleton`, `HeaderSkeleton`)
    - `apps/web/src/lib/workspace-context.tsx`
  - **Steps:**
    1. `AppShell` renders the static frame at once: sidebar container, header bar, `{children}`.
    2. The server fetches `/api/bootstrap` (one call, replacing the four) inside an async child under `<Suspense fallback={<SidebarSkeleton/>}>`. It passes the result as `initialData` to a client `useBootstrap()` query.
    3. A `401` from bootstrap means `redirect("/login")`, which still works inside Suspense in Next 15.
    4. The sidebar and header read projects, workspaces and connections from `useBootstrap()` / `useProjects(wsId)` instead of props.
    5. Delete the stale-cookie second round trip; bootstrap already picks the active workspace.
    6. `requireWorkspace` (`lib/workspace-route.ts`) uses `GET /api/workspaces/by-hash/:hash`, removing the `listWorkspaces` waterfall. Update the dashboard, code, tasks and workspace-settings pages so their own fetches run in parallel with it.
    7. Add a `navigation.test.ts` assertion that `app-shell.tsx` does not `await` anything at the top level.
  - **Acceptance:** With the API artificially delayed by 1 s, the shell frame and the page skeleton paint immediately and the sidebar fills in afterwards. Dashboard and code pages make one serial hop, not two.
  - **Verify:** `pnpm test -- navigation && pnpm --filter @ucch/web build`, plus a manual check with a delay

- [ ] **B5 — Migrate client data to query hooks (one task per domain)**
  - **Depends:** B3
  - **Pattern for every sub-task:**
    1. Keep the fetchers in `lib/<domain>-api.ts`.
    2. Add `lib/queries/<domain>.ts` exporting `use<X>()` (with `meta.persist` for list and tree views) and `use<Action>Mutation()` (optimistic `onMutate`, rollback in `onError`, `onSettled` invalidate).
    3. Replace `useEffect`+`useState` loading in the components, keeping the "loaded vs empty" distinction (`isPending` shows the skeleton).
    4. Remove `router.refresh()` calls the domain no longer needs.
  - **Sub-tasks:**
    - [ ] **B5.a — projects + sessions:** `lib/project-sessions.ts`, `app-sidebar.tsx`, `section-panel.tsx`, `projects-table.tsx`, `session-list.tsx`
    - [ ] **B5.b — tasks:** `lib/tasks-api.ts`, `components/tasks/tasks-board.tsx`
    - [ ] **B5.c — timeline:** `lib/timeline-api.ts`, `components/timeline/timeline-workspace.tsx`
    - [ ] **B5.d — notes tree + note meta:** `lib/notes-api.ts`, `components/notes/notes-context.tsx`, `notes-workspace.tsx`, `note-tree-sidebar.tsx`. Leave note *content* alone; R8 replaces it.
    - [ ] **B5.e — files tree:** `lib/files-api.ts`, `components/files-panel.tsx`. Persist the tree, not file contents.
    - [ ] **B5.f — git state:** `components/git/use-git-state.ts`. Keep the poll as `refetchInterval` (later 60 s, after R6).
    - [ ] **B5.g — database:** `lib/database-api.ts`, `components/database/db-context.tsx`, `connection-home.tsx`, `connections-panel.tsx`
    - [ ] **B5.h — keys, activity, quotas, account, workspace members:** `keys-api.ts`, `activity-api.ts`, `quota-rail.tsx`, `account-api.ts`, `workspace-api.ts`, `workspace-members-settings.tsx`
  - **Acceptance (each):** Revisiting the domain's page paints from cache instantly, then revalidates. No empty-state flash. The domain's `router.refresh()` calls are gone.
  - **Verify (each):** `pnpm typecheck && pnpm test && pnpm --filter @ucch/web build`

- [ ] **B6 — Leaf `loading.tsx` for sibling navigation + stricter test**
  - **Depends:** P0.1
  - **Files:**
    - new `loading.tsx` in:
      - `app/(app)/setting/[page]/`
      - `app/(app)/[workspaceHash]/workspace-settings/[page]/`
      - `app/(app)/[workspaceHash]/database/[connectionId]/[db]/[table]/`
      - `app/(app)/[workspaceHash]/p/[projectHash]/documentation/[noteId]/`
      - `app/(app)/[workspaceHash]/p/[projectHash]/(chat)/[sessionHash]/`
      - `app/shared/[slug]/notes/[[...noteId]]/`
    - `apps/web/src/app/navigation.test.ts`
    - `apps/web/src/components/page-skeletons.tsx`
    - `app/(app)/[workspaceHash]/database/[connectionId]/loading.tsx` (move its inline skeleton into `page-skeletons.tsx`)
    - `app/shared/[slug]/layout.tsx`
  - **Steps:**
    1. Each new `loading.tsx` renders the matching skeleton from `page-skeletons.tsx`: `SettingsSkeleton`, `TableRowsSkeleton` inside the table frame, `NotePageSkeleton`, `ConversationSkeleton`, `PublicNotesSkeleton`.
    2. In `navigation.test.ts`, require that every page under a dynamic segment has a `loading.tsx` **in its own segment directory**.
    3. Fix `shared/[slug]/layout.tsx` so it awaits nothing: move `fetchPublicProject` into a child under `Suspense`.
  - **Acceptance:** Session A → B, note A → B, settings page → page and table → table all paint the skeleton in the same frame (P0.3 suite).
  - **Verify:** `pnpm test -- navigation && pnpm --filter @ucch/web e2e`

- [ ] **B7 — Boot screen at sign-in**
  - **Depends:** B3, B4
  - **Files:**
    - new `apps/web/src/components/boot-screen.tsx`
    - `apps/web/src/components/login-form.tsx`
    - `apps/web/src/lib/warmup.ts`, `apps/web/src/lib/sections.ts`
    - `apps/web/src/lib/realtime.tsx`
    - new `apps/web/src/lib/last-location.ts`
    - `apps/web/src/components/app-logo.tsx`
  - **Steps:**
    1. Write `last-location.ts`: on each pathname change inside `(app)`, write a `ucch_last` cookie (path only, validated against the app's routes, `SameSite=Lax`).
    2. In `login-form.tsx`, after a successful `POST`, render `<BootScreen target={…}/>` in place of the form. Remove `router.replace("/")` and `router.refresh()`.
    3. In `BootScreen`, use `app-logo.tsx` and a progress bar driven by the steps below, in theme tokens. It must not be a spinner.
    4. In parallel:
       - bootstrap → `setQueryData`
       - `router.prefetch(target, {kind: FULL})`
       - prefetch the workspace sections and the recent project and session from `lib/warmup.ts` helpers
       - preload the icon sprite and the regular mono font
       - `import()` of the files panel and composer chunks
       - start the shared socket (expose `RealtimeProvider`'s connect so the boot screen can start it early, or open the socket when the shell mounts)
    5. When the bootstrap and target prefetch are done, or after 2000 ms, call `router.replace(target)`. The rest continues in the background.
    6. **Target:** a safe `?next=` (same-origin, an app route), else `ucch_last`, else the workspace home.
    7. On first app mount with an empty persisted cache (hard load after GitHub OAuth), show the same screen as an overlay until bootstrap resolves.
  - **Acceptance:**
    - Login → usable shell in under 2 s on loopback.
    - The first page after login shows real data with no skeleton flash.
    - No double render of the shell (verified in React Profiler or with a log once).
  - **Verify:** `pnpm --filter @ucch/web e2e` (login step), plus manual

---

## Phase R (core): Everything live

- [ ] **R1 — `workspace:{id}` topic**
  - **Depends:** S3
  - **Files:** `packages/protocol/src/rpc.ts`, `packages/protocol/src/events.ts`, `apps/server/src/bus.ts`, `apps/server/src/ws.ts`, `apps/server/src/access.ts`, `apps/web/src/lib/client.ts`, `apps/web/src/lib/realtime.tsx`
  - **Steps:**
    1. Add the `workspace` topic kind and `EventBus.publishToWorkspace(workspaceId, event)`.
    2. Subscribe ACL: workspace membership, any role. Revocation is handled by S3.
    3. `RealtimeProvider` subscribes to the active workspace (from `ActiveWorkspaceContext`) and switches the subscription on change.
    4. Tests: a member receives the event, a non-member is refused, switching workspaces moves the subscription.
  - **Acceptance:** A test event published to the workspace reaches every member's tab.
  - **Verify:** `pnpm test -- bus ws`

- [ ] **R2 — Route workspace-level changes to the workspace topic**
  - **Depends:** R1
  - **Files:** `apps/server/src/route-audit.ts` (new scope `"workspace"`), `apps/server/src/workspaces.ts`, `workspace-members-routes.ts`, `workspace-members.ts`, `database-routes.ts`, `database-connections.ts`, `db-manager/*`, project create and delete in `index.ts` and `decide.ts`, account profile routes
  - **Steps:**
    1. Publish `resource.changed{resource, id}` (or richer events where the entity is small) to the workspace topic for:
       - project created, deleted, renamed (`project.created` also goes to the workspace topic)
       - workspace update, archive, delete
       - member add, remove, role change
       - invite create, revoke, accept
       - credential policy
       - DB connection CRUD
       - DB-manager data and schema changes
    2. Profile name and avatar changes go to every workspace the user belongs to.
    3. An added or removed member gets `resource.changed{workspaces}` on `user:{id}`.
    4. Extend the tests in `route-audit` for the new scope mapping.
  - **Acceptance:** Two browsers as two members: everything listed above appears in the other browser without a refresh (after R3 wires the cache).
  - **Verify:** `pnpm test -- route-audit workspace-members`

- [ ] **R3 — Realtime → cache bridge**
  - **Depends:** B3, R1
  - **Files:** new `apps/web/src/lib/realtime-cache.ts` and `realtime-cache.test.ts`, `apps/web/src/lib/realtime.tsx` (replace `AccountRefresher`), `apps/web/src/lib/query-keys.ts`
  - **Steps:**
    1. One `applyEvent(queryClient, event)` that switches on type/resource and calls `setQueryData` when the event carries the entity, otherwise `invalidateQueries` with keys from `query-keys.ts`.
    2. Mount it once in `RealtimeProvider` for the user, workspace and every subscribed project topic.
    3. Replace `AccountRefresher`'s `router.refresh()` with the bridge. Keep `refresh()` only where the server-rendered *page* itself must change, and list those in the `navigation.test.ts` allowlist.
    4. Unit-test every mapping.
  - **Acceptance:** `router.refresh()` is not called on realtime events. Shell lists update live.
  - **Verify:** `pnpm test -- realtime-cache navigation`

- [ ] **R4 — Resync after reconnect**
  - **Depends:** R3
  - **Files:** `apps/web/src/lib/client.ts` (`ready` handling, reconnect around lines 369–383), `apps/web/src/lib/realtime.tsx`
  - **Steps:**
    1. On `ready` after a drop (not the first connect), call `queryClient.invalidateQueries({ refetchType: "active" })` and re-send presence.
    2. Replace "give up after 10 attempts" with a capped backoff that keeps trying while the tab is visible, plus an "Offline — reconnecting" banner (no spinner).
  - **Acceptance:** Kill the server for 20 s and restart it. Changes made by others during the gap appear without a reload.
  - **Verify:** manual, plus a unit test of the reconnect state machine if extracted

- [ ] **R5 — Fill missing events**
  - **Depends:** R3
  - **Files:**
    - `apps/server/src/git-routes.ts`
    - `apps/server/src/index.ts` (`runDiagramJob`, diagram routes around lines 1849–1915, uploads)
    - `apps/server/src/preview.ts`, `apps/server/src/decide.ts`
    - `apps/server/src/uploads.ts`, `apps/server/src/route-audit.ts`
    - `packages/protocol/src/events.ts`
    - `apps/web/src/components/files-panel.tsx`, `apps/web/src/components/diagrams/*`, `apps/web/src/components/preview-dialog.tsx`
  - **Steps:**
    1. git remote PUT/DELETE → `resource.changed{git}`; git fetch → `git.fetched`.
    2. Diagram jobs: keep job state in a `Map` but publish `diagram.job{kind, state, path?, error?}` on start, done and failed. The UI subscribes; GET stays for the initial load.
    3. Emit the already-defined `preview.published`, `port.opened` and `port.closed` where publishing and port detection happen. `preview-dialog.tsx` stops polling.
    4. Upload delete and attach → `upload.changed`. Attach's `file.changed` gets `origin: "system"`.
    5. `file.changed` gets an optional `worktreeId`. `files-panel.tsx` handles events without an origin (agent, git, fs) and filters by the worktree it shows.
    6. Add the task routes to `SELF_AUDITED`.
    7. Add the bridge mappings (R3) for every new event.
  - **Acceptance:** Every row of plan.md §C.5 is visible live in a second browser.
  - **Verify:** `pnpm test`, plus a manual two-browser check

- [ ] **R6 — File watcher**
  - **Depends:** R5
  - **Files:** new `apps/server/src/file-watcher.ts` and `.test.ts`, `apps/server/src/ws.ts` (subscriber counts per project), `apps/server/src/files.ts` (versions the server wrote), `apps/server/package.json` (`@parcel/watcher`)
  - **Steps:**
    1. `FileWatcher.retain(projectId, worktreeRoot)` and `release()`. It starts on the first project subscriber and stops 60 s after the last one leaves.
    2. Ignore `.git`, `node_modules`, `vendor`, `.next`, `dist`, `.ucch/cache`.
    3. Coalesce over 150 ms.
    4. Skip paths whose resulting content version equals the one `files.ts` just wrote, so the server's own writes don't echo.
    5. Publish `file.changed{origin: "fs", paths, worktreeId}`.
    6. Git status refetches on these events. Lower the git poll to 60 s.
    7. Tests use a temp dir.
  - **Acceptance:** `echo x > foo.txt` in a terminal shows `foo.txt` in another user's tree within 1 s.
  - **Verify:** `pnpm test -- file-watcher`

- [ ] **R7 — Presence with real people**
  - **Depends:** R1
  - **Files:**
    - `apps/server/src/presence.ts`, `apps/server/src/ws.ts` (presence handling, around lines 335–357)
    - `packages/protocol` (presence entry type)
    - `apps/web/src/lib/realtime.tsx` (`usePresence`, `usePresenceLocation`, `othersAt`)
    - `apps/web/src/components/presence-badge.tsx`
    - `apps/web/src/lib/selection-color.ts`
    - views: `code-editor.tsx`, `tasks-board.tsx`, `timeline-workspace.tsx`, `database/database-shell.tsx`, `git/git-view.tsx`
  - **Steps:**
    1. Presence entries gain `name`, `avatarUrl` and `color`. The server fills them from the session user; never trust the client.
    2. `presence-badge.tsx` becomes an avatar stack with names on hover. One's own other tabs fold into "you (2 tabs)".
    3. Call `usePresenceLocation` in each listed view with a meaningful location (file path, task id, table name).
  - **Acceptance:** Two users see each other's avatars and where each one is.
  - **Verify:** `pnpm typecheck && pnpm test`, plus manual

---

## Phase B (rest): Polish and budgets

- [ ] **B8 — One WebSocket per tab**
  - **Depends:** R3
  - **Files:** `apps/web/src/lib/client.ts` (subscription dedupe, around line 236), `apps/web/src/lib/realtime.tsx`, `components/project-chat.tsx` (around line 381), `components/terminal-view.tsx`, `components/login-terminal-dialog.tsx`, `lib/create-project.ts`
  - **Steps:**
    1. Fix the dedupe: reference-count per topic. The effective `quiet` is the AND of all holders, and it's re-sent when a holder is released.
    2. Expose `useRealtime().subscribe(topic, opts, onEvent)` and `dispatch()`.
    3. Port the four components to the shared client and delete their `new UcchClient(...)`.
  - **Acceptance:** DevTools shows one `/ws` connection per tab after visiting chat, a terminal and project creation.
  - **Verify:** `pnpm test -- client`, plus manual

- [ ] **B9 — Links to final URLs + router cache + warmup**
  - **Depends:** B5.a
  - **Files:** `components/section-panel.tsx` (around line 184), `components/projects-table.tsx` (around lines 141 and 201), `lib/sections.ts`, `lib/warmup.ts` / `warmup.test.ts`, `components/route-warmup.tsx`, `apps/web/next.config.ts`
  - **Steps:**
    1. Project links resolve the newest session from the cached sessions query. Fall back to the new-session URL, never the redirect stub.
    2. Set `experimental.staleTimes: { dynamic: 30, static: 300 }`.
    3. Warmup changes:
       - re-run after any `router.refresh()`
       - re-run on `visibilitychange` when more than 4 minutes have passed
       - include the 3 most recent projects and each one's latest session page
       - keep the 150 ms gaps and `requestIdleCallback`
       - update `warmup.test.ts`
  - **Acceptance:** Clicking a project from the dashboard makes no redirect request (check the Network tab).
  - **Verify:** `pnpm test -- warmup sections`, plus the e2e suite

- [ ] **B10 — Fonts and file icons**
  - **Depends:** P0.1
  - **Files:** `apps/web/src/app/layout.tsx` (fonts), `apps/web/src/app/file-icons/route.ts`, new `apps/web/src/app/file-icons/resolve/route.ts` and `file-icons/svg/[id]/route.ts`, `apps/web/src/lib/file-icons.ts`, file-tree components
  - **Steps:**
    1. Split iA Writer Mono so only Regular is preloaded. Italic and bold use `preload: false`. **Keep the one-child `<body>` and the unauthored `<head>` rules documented in `layout.tsx`.**
    2. `resolve?names=` returns `{name: iconId}` with `Cache-Control: max-age=86400`.
    3. `svg/[id]` serves the SVG with `immutable`, one year.
    4. The tree batches the names it hasn't seen into a resolve call and renders `<img src="/file-icons/svg/<id>.svg">`.
    5. Keep the old route for compatibility.
  - **Acceptance:** Opening a 200-file tree costs ≤ 1 resolve plus one SVG request per distinct icon. The login page preloads one mono font file.
  - **Verify:** `pnpm test -- file-icons`, plus the Network tab

- [ ] **B11 — Bundle splitting + budgets**
  - **Depends:** P0.3
  - **Files:** `apps/web/next.config.ts` (`@next/bundle-analyzer` behind `ANALYZE=1`, `optimizePackageImports`), `components/app-shell.tsx` / `right-sidebar.tsx` (files panel), `QuickActions`, `TaskDialog`, `NewProjectDialog`, `components/markdown.tsx`, `lib/highlight-lines.ts` consumers, `lib/warmup.ts` (add the new chunks)
  - **Steps:**
    1. Run the analyzer and record the top modules in the PR.
    2. Move the listed components behind `dynamic()`. Their placeholders use skeletons, and warmup imports them on idle.
    3. Add `optimizePackageImports: ["lucide-react", "@base-ui/react"]`.
    4. Add a budget check script comparing `next build` first-load JS to `e2e/results/baseline.json`. It fails when a route grows by more than 10%.
  - **Acceptance:** Shell-route first-load JS is at least 25% below the baseline.
  - **Verify:** `ANALYZE=1 pnpm --filter @ucch/web build`, plus the budget script

- [ ] **B12 — SSR → API keep-alive**
  - **Depends:** P0.1
  - **Files:** `apps/web/src/lib/session.ts`, `apps/web/src/lib/public-api.ts`
  - **Steps:** Create one module-level undici `Agent({ keepAliveTimeout: 30_000, connections: 32 })`, pass it as `dispatcher` on every server-side fetch, and wrap the readers in React `cache()` where they aren't already.
  - **Acceptance:** SSR→API calls reuse connections (check `ss -tn` or Agent stats).
  - **Verify:** `pnpm typecheck && pnpm --filter @ucch/web build`

- [ ] **B13 — Real-user web vitals**
  - **Depends:** B1
  - **Files:** new `apps/web/src/components/vitals-reporter.tsx` (`web-vitals`), new server route `POST /api/metrics/vitals` (+ migration `perf_vitals`), `lib/view-transitions.tsx` (nav marks)
  - **Steps:**
    1. Report LCP, INP, CLS and TTFB, plus custom `nav-skeleton` and `nav-content` timings, via `navigator.sendBeacon`. Batch them and sample at 100%, configurable.
    2. The server rate-limits the endpoint and stores the timings with route template, not the full URL.
    3. Mark `nav-start` in `TransitionLink` and `nav-content` when the page's data is ready (query success).
  - **Acceptance:** Rows appear after navigating around. No PII is stored.
  - **Verify:** `pnpm test`, plus a DB check

---

## Phase R (collab): Real-time co-editing

- [ ] **R8 — Hocuspocus server on `/collab`**
  - **Depends:** R1, D2 (upgrade routing), S3
  - **Files:** new `apps/server/src/collab.ts` and `collab.test.ts`, `apps/server/src/index.ts` (upgrade handler, shutdown), `packages/db/src/schema.ts` + new migration `note_ydocs`, `apps/server/src/notes.ts`, `apps/server/package.json` (`@hocuspocus/server`, `yjs`, `y-prosemirror`, `@tiptap/*` for server-side schema conversion; pin exact versions matching the web's Tiptap 3.31.3)
  - **Steps:**
    1. `noInterface` Hocuspocus instance. The upgrade on `/collab` goes to `hocuspocus.handleConnection(ws, req)`.
    2. `onAuthenticate`: redeem a ws-ticket (`auth.ts`), parse the document name `note:{id}`, check `ProjectAccess.canAccessProject` for the note's project, and reject otherwise.
    3. Add table `note_ydocs(note_id pk fk→notes on delete cascade, state bytea not null, updated_at)`.
    4. `onLoadDocument`: load the state, or seed it once from `notes.content` (markdown → ProseMirror JSON with the same extension set as `note-editor-impl.tsx` → `prosemirrorJSONToYDoc`).
    5. `onStoreDocument` (debounce 2 s, max 10 s): save the state **and** project it to `notes.content` as markdown via `yDocToProsemirrorJSON` and the Tiptap markdown serializer. Publish `note.changed` without content, so the tree and title update.
    6. Unload documents 30 s after the last connection. Report the open-doc count in `/health`.
    7. Server-side writes (agent documentation tools in `packages/agent/src/tools/documents.ts`, REST content PATCH) go through `openDirectConnection` and apply as a Yjs transaction.
    8. Tests:
       - two clients converge
       - an unauthorized client is rejected
       - the projection writes `content`
       - a server-side write reaches connected clients
  - **Acceptance:** Two headless Yjs clients editing the same note converge, and `notes.content` reflects the merge within 10 s.
  - **Verify:** `pnpm test -- collab`

- [ ] **R9 — Notes editor co-editing**
  - **Depends:** R8, R7
  - **Files:** `apps/web/src/components/notes/note-editor-impl.tsx`, `note-editor.tsx`, `notes-workspace.tsx`, `apps/web/src/lib/note-autosave.ts`, `apps/web/package.json` (`@hocuspocus/provider`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret`, `yjs`; exact versions matching Tiptap 3.31.3)
  - **Steps:**
    1. Create a `HocuspocusProvider` per open note: URL `/collab` on the page host, with a ticket from `POST /api/ws-ticket`.
    2. Add the Collaboration extension, and disable StarterKit `undoRedo`.
    3. Add CollaborationCaret with user name and colour from presence.
    4. Remove the content autosave path, the whole-document `setContent` on `note.changed` and the `ifUpdatedAt` 409 handling for content. Title, icon and cover stay on REST.
    5. While the provider is syncing, show `NotePageSkeleton`; after the first sync, the editor.
    6. Offline: Yjs keeps local edits and they sync on reconnect. Show the R4 banner.
  - **Acceptance:** Two browsers type in the same paragraph at once with live carets, and nothing is lost or reverted.
  - **Verify:** `pnpm --filter @ucch/web build`, plus a manual two-browser check, plus an e2e test with two contexts

- [ ] **R10 — Code + diagram co-editing**
  - **Depends:** R9, R6
  - **Files:** `apps/server/src/collab.ts` (file docs), `apps/server/src/files.ts`, `apps/server/src/file-watcher.ts`, `apps/web/src/lib/doc-sync.ts` (move `replacement()` into `packages/protocol` and re-export), `apps/web/src/components/code-editor.tsx`, `components/diagrams/diagram-editor.tsx`, `y-codemirror.next`
  - **Steps:**
    1. Document name `file:{projectId}:{worktreeId}:{path}`. Load from disk, with no DB persistence.
    2. Write-back to disk is debounced 1 s through `workspaceFiles.write`, which bumps the version so the watcher skips it.
    3. When the watcher or agent reports an external change, apply `replacement(docText, diskText)` as one Yjs transaction.
    4. Unload after 30 s idle.
    5. Client: a `yCollab` extension in CodeMirror, with the vim mode still working. Remove `ifVersion` save conflicts for co-edited files.
  - **Acceptance:** Two users edit the same file live. An agent edit to that file merges into both editors without moving cursors.
  - **Verify:** `pnpm test -- collab`, plus manual

- [ ] **R11 — Optimistic, per-field mutations for tasks and timeline**
  - **Depends:** B5.b, B5.c, R3
  - **Files:** `apps/server/src/tasks-routes.ts`, `apps/server/src/tasks.ts`, `apps/server/src/timeline-routes.ts`, `lib/queries/tasks.ts`, `lib/queries/timeline.ts`
  - **Steps:**
    1. PATCH accepts partial fields and updates only those columns.
    2. Events carry the updated entity, and the bridge patches it into the cache.
    3. Mutation hooks update optimistically.
  - **Acceptance:** Two users dragging different tasks, or editing different fields of one task, never overwrite each other.
  - **Verify:** `pnpm test -- tasks timeline`

- [ ] **R12 — DB-manager row conflict detection**
  - **Depends:** R2
  - **Files:** `apps/server/src/db-manager/adapter.ts`, `apps/server/src/database-routes.ts`, `components/database/browse-tab.tsx`
  - **Steps:**
    1. Row update requests include the original values of the changed columns. The adapter adds them to the `WHERE`.
    2. If 0 rows are affected, return `409` with the current row.
    3. The UI shows a conflict toast with "Use theirs / Overwrite".
    4. A successful update publishes `resource.changed{database_data, table}` to the workspace topic.
  - **Acceptance:** Concurrent edits of one cell produce a visible conflict, not a silent overwrite.
  - **Verify:** `pnpm test -- database`

---

## Phase W: PWA groundwork

- [ ] **W1 — Manifest, icons, theme colour**
  - **Depends:** P0.1
  - **Files:** new `apps/web/src/app/manifest.ts`, new icons in `apps/web/src/app/` (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`), `apple-icon.png` replaced with 180×180, `apps/web/src/app/layout.tsx` (`export const viewport = { themeColor }`), `apps/web/src/middleware.ts` matcher (exclude `manifest.webmanifest`)
  - **Steps:** Generate the icons from `icon.svg` or `components/app-logo.tsx`. Manifest values: `display: "standalone"`, `start_url: "/"`, `scope: "/"`, and colours from theme tokens.
  - **Acceptance:** Chrome DevTools → Application → Manifest shows no errors.
  - **Verify:** `pnpm --filter @ucch/web build`, plus DevTools

- [ ] **W2 — Static root layout**
  - **Depends:** W1
  - **Files:** `apps/web/src/app/layout.tsx`, `apps/web/src/lib/theme.ts`, `apps/web/src/components/theme-provider.tsx`, `apps/web/src/middleware.ts`
  - **Steps:**
    1. Stop calling `cookies()` in the root layout. The middleware reads the theme cookie and sets a response header the layout can't read statically, so instead:
       - apply the theme on the client from cookie or localStorage before first paint, through the existing `ThemeProvider`
       - for the no-flash requirement, keep a `data-theme-mode` default of system and accept the trade-off on forced themes, **or** keep `(app)` dynamic and make only `/login` and `/offline` static through a separate root layout group
       - choose the second option if the first causes a visible flash, and document the choice in the PR
    2. **Don't break the hydration rules documented in `layout.tsx`.**
  - **Acceptance:** The `next build` output marks `/login` as static (○). No theme flash on a forced-dark reload.
  - **Verify:** `pnpm --filter @ucch/web build`

- [ ] **W3 — Serwist service worker behind a flag**
  - **Depends:** W2, B3
  - **Files:** `apps/web/next.config.ts` (`withSerwist`, enabled only when `NEXT_PUBLIC_PWA=1`), new `apps/web/src/app/sw.ts`, `apps/web/package.json` (`@serwist/next`, `serwist`)
  - **Steps:**
    1. Precache the build manifest entries for the shell route chunks, fonts and `/offline`.
    2. Runtime caching:
       - `/_next/static` cache-first
       - `/file-icons/svg/*` stale-while-revalidate
       - navigations network-first with a 3 s timeout, then the cached shell, then `/offline`
       - RSC (`RSC: 1` header) network-only
    3. **Exclude:** `/api/*`, `/ws`, `/collab`, preview hosts.
    4. Register only in production when the flag is on.
    5. Make sure the edge (D2) serves `sw.js` with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`.
  - **Acceptance:** With the flag on, Lighthouse's PWA "installable" check passes. Turning the flag off and redeploying unregisters the service worker (ship a kill-switch `sw.js`).
  - **Verify:** `NEXT_PUBLIC_PWA=1 pnpm --filter @ucch/web build && start`, plus Lighthouse

- [ ] **W4 — Offline page**
  - **Depends:** W3
  - **Files:** new `apps/web/src/app/offline/page.tsx` (static)
  - **Steps:** Show the app logo, "You're offline", a retry button, and a list of cached recent projects from the persisted query cache (read-only).
  - **Acceptance:** In DevTools offline mode, a navigation shows this page.
  - **Verify:** manual

- [ ] **W5 — Update prompt + install entry**
  - **Depends:** W3, B1
  - **Files:** new `apps/web/src/components/update-toast.tsx`, `apps/web/src/components/nav-user.tsx`
  - **Steps:**
    1. When bootstrap's `buildId` differs from the running build (`process.env.NEXT_PUBLIC_BUILD_ID`), or the service worker reports `waiting`, show "New version available — Reload".
    2. Capture `beforeinstallprompt` and show an "Install app" item in the user menu.
  - **Acceptance:** Deploying a new build while a tab is open shows the toast, and reloading picks up the new version.
  - **Verify:** manual

---

## Definition of Done

All boxes above are checked, and these hold on the production container (`scripts/smoke-container.sh` plus `pnpm --filter @ucch/web e2e` pointed at it):

| Metric | Baseline (P0.3) | Target |
|---|---|---|
| Click → skeleton or new page (p95) | 46 ms | ≤ 100 ms |
| Click → content, cached data | 52–85 ms (warm sections) | ≤ 150 ms |
| Click → content, cold data | 400 ms p95 (documentation, dashboard) | ≤ 600 ms |
| Login submit → interactive shell | not measured yet (B7 adds the login step) | ≤ 2.0 s |
| Hard reload → sidebar painted | 582 ms (whole first page, no skeleton) | ≤ 300 ms |
| Shell-route first-load JS | 315 kB gz (`/(app)/…` minimum); session page 415 kB | ≤ baseline × 0.75 |
| `/ws` connections per tab | 2+ on a chat page (shared + per-mount) | 1 (+1 per co-edited doc) |
| Changes visible to another member | partial | every row in plan.md §C.2 and §C.5, without a refresh |
| Deploy | 6 compose services | 1 Dokploy Dockerfile application, 1 port, 1 volume |
