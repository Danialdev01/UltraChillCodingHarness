# UCCH: single container, instant navigation, everything live

**Status:** proposed · **Date:** 2026-10-18 · **Agent task list:** [`todo.md`](./todo.md)

This plan covers four connected goals:

1. **One container.** Deploy UCCH as a single Docker image: a Dokploy *Application → Dockerfile*, one click, one port, one volume.
2. **Instant navigation.** Every click paints the next page in the same frame, showing a skeleton for whatever is still loading. A boot screen at sign-in preloads and caches the data and media every page needs.
3. **Everything live.** A change one user makes appears for every other user who can see it, without a refresh. Documentation notes support real-time co-editing.
4. **PWA-ready.** Build the groundwork now: a persisted client cache, a static shell, a manifest and a service worker behind a flag. The app can later be installed and load only the parts it needs.

Each section first states what exists today, with file references, and then what changes. `todo.md` turns this into ordered tasks an agent can execute.

---

## 0. Decisions already made

| Topic | Decision |
|---|---|
| Databases | **Embedded by default, external optional.** PostgreSQL 16 runs inside the container. If `DATABASE_URL` is set, the embedded Postgres is not started. |
| MySQL dev databases | **Optional.** A MySQL-compatible server (MariaDB) is installed in the image but starts only when `ENABLE_MYSQL=true` and `DEV_MYSQL_URL` is unset. |
| Notes collaboration | **Real-time co-editing** with Yjs (CRDT): several people type in the same note at once and see each other's cursors. |
| Process model | One container. Inside it, one API/edge process, one Next.js process and the databases, all managed by a supervisor. |
| Client data | One client cache (TanStack Query) persisted to IndexedDB. WebSocket events update the cache instead of calling `router.refresh()`. |

Non-goals for this plan:
- Running more than one server replica.
- Moving user projects into their own containers. `packages/runtime` is still an empty placeholder.
- Offline editing. The PWA work makes the app installable and fast to start, not usable without a network.

---

## 1. Current state

### 1.1 Deployment

`docker-compose.yml` runs six services behind Traefik labels:

| Service | What it is | Notes |
|---|---|---|
| `secrets` | alpine one-shot running `deploy/secrets.sh` | Generates `SECRET_KEY`, the DB passwords, the default user password and the crawl4ai token into a volume. An env value always wins. |
| `postgres` | `postgres:16-alpine` | DB `ucch` holds the harness data. `deploy/postgres-init.sh` creates the `dev` role and db and revokes PUBLIC on `ucch`. |
| `mysql` | `mysql:8.4` | Dev databases only. `deploy/mysql-init.sql` grants to `dev`. |
| `server` | `Dockerfile` target `server` on :3001 | Fastify API, `/ws`, terminals, agents, preview proxy. Runs TypeScript through `tsx`, with devDependencies installed. `deploy/server-entrypoint.sh` builds the DB URLs from the compose hostnames `postgres`/`mysql`, then drops to `node` via `setpriv`. |
| `web` | `Dockerfile` target `web` on :3000, ×`WEB_REPLICAS` | Next.js 15.5 standalone. |
| `crawl4ai` | optional `research` profile | Research crawler. |

Traefik routes `/api` and `/ws` to `server`, `p{port}-{hash}.ROOT_DOMAIN` to `server` (live previews, wildcard certificate via DNS-01), and everything else to `web`.

Facts that constrain the redesign:
- **The server must be a single process.** All of the following live in memory:
  - `EventBus` (`apps/server/src/bus.ts`)
  - the WebSocket gateway (`ws.ts`)
  - terminals (`terminals.ts`)
  - agent turns (`agent.ts`)
  - the task pipeline
  - ws and preview tickets (`auth.ts`, `preview.ts`)
  - presence
  - the composer
- **Migrations run on every boot** (`packages/db/src/bootstrap.ts`), so the image must ship `packages/db/migrations`.
- **Preview subdomains need the original `Host` header** at the server. `serverFactory` sends every request to `preview.handleRequest` first, and upgrades go to `preview.handleUpgrade` (`apps/server/src/index.ts`, around lines 505 and 3065).
- **Next does not proxy WebSocket upgrades.** Its `/api` rewrite in `apps/web/next.config.ts` is only for development.
- **SSR calls the API at `SERVER_ORIGIN`** and forwards the `ucch_session` cookie by hand (`apps/web/src/lib/session.ts`).
- **Only Postgres is required.** `DEV_POSTGRES_URL` and `DEV_MYSQL_URL` are optional: `dev-database.ts` skips an engine that isn't configured, and `clone.ts` reports that it was skipped.
- `apps/gateway`, `packages/runtime` and `packages/vcs` are empty placeholders.

### 1.2 Navigation and loading

What already works well:
- Every route has a `loading.tsx` at or above it.
- Skeletons live in `components/page-skeletons.tsx`.
- `TransitionLink` and `useTransitionRouter` (`lib/view-transitions.tsx`) wrap navigation in view transitions.
- `components/route-warmup.tsx` prefetches sections after the first idle.
- `navigation.test.ts` enforces the rules above.
- Heavy editors (CodeMirror, Tiptap, xterm, tldraw, mermaid) are already code-split.

What's slow, most important first:

1. **The `(app)` layout blocks.**
   - `components/app-shell.tsx` (around line 53) awaits `/api/me`, `/api/workspaces`, `projects` and `database-connections` before anything paints.
   - Nothing above it has a boundary.
   - A stale workspace cookie adds a second serial round trip.
2. **Login preloads nothing and renders twice.**
   - `components/login-form.tsx` (around line 60) calls `router.replace("/")` and then `router.refresh()`.
   - The login page stays frozen inside the view transition while the shell's four calls run.
   - Warmup only starts after the first app page is idle.
3. **Moving between siblings freezes the old page.** These routes have no leaf `loading.tsx`, so going from session A to session B (and similar) waits on the server:
   - `setting/[page]`
   - `[workspaceHash]/workspace-settings/[page]`
   - `database/[connectionId]/[db]/[table]`
   - `p/[projectHash]/documentation/[noteId]`
   - `p/[projectHash]/(chat)/[sessionHash]`
   - `shared/[slug]/notes/[[...noteId]]`
4. **There is no client data cache.**
   - Every component fetches in `useEffect` again on each mount.
   - The shell's lists only update through `router.refresh()`, which is called from about 24 places, including `AccountRefresher` in `lib/realtime.tsx`.
   - Each refresh re-runs `AppShell` and throws away the router's prefetch cache.
5. **Server pages have waterfalls.**
   - `requireWorkspace` in `lib/workspace-route.ts` calls `listWorkspaces` before each page's own data.
   - Affected pages: dashboard, code, tasks and workspace-settings.
6. **Extra sockets and redirect hops.**
   - `components/project-chat.tsx` (around line 381) opens a new WebSocket on every mount: a ticket, a handshake, then a replay.
   - `section-panel.tsx` and `projects-table.tsx` link to the bare project URL, which redirects to the newest session.
7. **Warmup is short-lived.**
   - It runs once per tab and covers a single project, skipping chat and session pages.
   - Next's default 5-minute stale time expires it, and any `refresh()` wipes it.
8. **Assets.**
   - All four iA Writer Mono faces (about 156 KB) are preloaded on every page, including login.
   - `/file-icons` is keyed by file name, so a tree of N names costs N requests.
   - The root layout reads `cookies()` for the theme, which makes every route dynamic, including `/login`.
9. **PWA.** There's no manifest, no service worker and no `public/` directory, and `apple-icon.png` is only 662 B.

### 1.3 Realtime

What already works:
- **Transport.** One `UcchClient` per tab (`lib/realtime.tsx`, `lib/client.ts`), authenticated with a ws ticket. Topics are `project`, `thread`, `terminal` and `user`. Agent threads are event-sourced (`eventstore.ts`) and replayed by sequence number.
- **Live features.** Agent chat, the shared composer draft, sessions, tasks and timeline (as "refetch" nudges), notes (whole-document pushes), keys, the activity feed and git (live plus a 10-second poll).

Gaps:

| Gap | Effect |
|---|---|
| No `workspace` topic | Workspace, member, invite, project create/delete, DB-connection, DB-data and profile changes only reach the acting user's own tabs (`route-audit.ts`, which uses account scope). |
| Only thread topics replay | After a reconnect, project-level events are lost, and nothing refetches. |
| No file watcher | Edits made in a terminal, by a dev server or by hand never reach the file tree. |
| Missing events | git remote PUT/DELETE and git fetch, diagram generate jobs (polled in memory), `preview.published` / `port.*` (defined but never emitted), and upload delete. `file.changed` without an origin is ignored by `files-panel.tsx`. |
| Last-write-wins editing | Notes, code and diagrams use `ifUpdatedAt`/`ifVersion` with a 409 revert. |
| Presence is anonymous | `presence-badge.tsx` says "another window". There's no presence in code, tasks, timeline, the DB manager or git. |
| **Security** | `terminal.output` is also published to the **project** topic (`bus.ts`, `index.ts` around line 340), so every member receives every member's terminal bytes. The `terminal` topic has no ACL (`ws.ts` around line 220). Cached access in `ws.ts` (around line 391) is never revoked. |

There's also an existing bug in the uncommitted work: `runDiagramJob` (`apps/server/src/index.ts`, around line 1867) passes an undefined `tree` to `workspaceFiles.write`.

---

## 2. Target architecture

```
                         Dokploy (Traefik) ── one domain ── :3000
                                         │   (+ optional *.ROOT_DOMAIN for previews)
┌────────────────────────────────────────▼──────────────────────────────────────────┐
│ ucch container                     PID 1: s6-overlay v3                           │
│                                                                                   │
│  oneshot  init-dirs ─► init-secrets                                               │
│                                                                                   │
│  longrun  postgres  127.0.0.1:5432   (skipped if DATABASE_URL is set)             │
│  longrun  mysql     127.0.0.1:3306   (only if ENABLE_MYSQL=true, no DEV_MYSQL_URL)│
│  longrun  web       127.0.0.1:3100   node apps/web/server.js  (Next standalone)   │
│  longrun  server    0.0.0.0:3000     node apps/server/dist/server.mjs  ◄── EDGE   │
│                                                                                   │
│  EDGE routing (Fastify serverFactory, in order):                                  │
│   1. Host = p{port}-{hash}.ROOT_DOMAIN  → preview gateway (HTTP + upgrades)       │
│   2. /ws (upgrade)                      → WebSocket gateway                       │
│   3. /collab (upgrade)                  → Hocuspocus (Yjs)                        │
│   4. /api/*, /health                    → Fastify routes                          │
│   5. /_next/static/*                    → disk, Cache-Control: immutable          │
│   6. everything else                    → stream-proxy to Next :3100              │
│                                                                                   │
│  /data (one volume): postgres/ mysql/ workspaces/ creds/ secrets/                 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Client side:

```
login ─► BootScreen ──► GET /api/bootstrap ─► QueryClient (persisted: IndexedDB)
                   ├──► open shared WebSocket (RealtimeProvider)
                   ├──► router.prefetch(final URL, last project/session, sections)
                   └──► preload fonts / icon sprite / core chunks
        ─► router.replace(final URL)   (no "/" hop, no refresh)

any page:  cached data paints instantly ─► background revalidate
           WS event ─► realtime-cache bridge ─► setQueryData / invalidate
           click ─► skeleton in the same frame (leaf loading.tsx) ─► data
```

---

## 3. Part A: one container

### A.1 Image

The Dockerfile keeps its build stages (`deps`, `web-build`) and adds:

- **`server-build`.** Bundles `apps/server/src/index.ts` and the workspace packages with **esbuild** into `apps/server/dist/server.mjs`, targeting node22 ESM.
  - Native and dynamic dependencies stay external: `@lydell/node-pty`, `postgres`, `mysql2`, `fastify` plugins if needed.
  - Only production dependencies are installed (`pnpm deploy --prod` for `@ucch/server`).
  - This removes `tsx` and the devDependencies from runtime, which shortens cold start and shrinks the image.
- **`app` (final).**
  - Starts from `node:22-bookworm-slim` with the same toolchain as today's `server` stage: git, ripgrep, php+composer, DB clients, the doc-kit (pandoc, typst, LibreOffice, chromium, mermaid-cli, python venv) and fonts.
  - Adds:
    - **PostgreSQL 16** from the PGDG apt repository, which keeps the on-disk format of today's `postgres:16` volumes.
    - **MariaDB server** from Debian (MySQL-compatible). It's installed but not started unless enabled. *Alternative:* MySQL 8.4 from Oracle's apt repo, if strict MySQL parity matters more than size.
    - **s6-overlay v3** (pinned tarballs) as `ENTRYPOINT ["/init"]`, replacing tini.
  - Copies in:
    - the Next standalone output (`.next/standalone` + `.next/static`)
    - the server bundle and its production `node_modules`
    - `packages/db/migrations`
    - `packages/agent/doc-kit`
    - the s6 service tree (`deploy/s6/`)
- **Targets.** The old `server` and `web` targets can stay for one release, then go.

### A.2 Supervision (s6-overlay)

Services live in `deploy/s6/s6-rc.d/` and are started in dependency order. s6 stops them in reverse order. `S6_KILL_GRACETIME=60000` matches today's `stop_grace_period: 60s`, so the server can still drain its workers. `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` makes a broken boot stop the container instead of running half-up.

| Service | Type | Runs as | Depends on | Does |
|---|---|---|---|---|
| `init-dirs` | oneshot | root | — | Creates `/data/{postgres,mysql,workspaces,creds,secrets}`. Sets owners: `postgres`, `mysql`, `node`, `node`, root. Modes: `0700` for postgres, mysql and secrets. |
| `init-secrets` | oneshot | root | init-dirs | Ports `deploy/secrets.sh` to write `/data/secrets/*`. An env value always wins; a file is only generated when missing. |
| `postgres` | longrun | postgres | init-secrets | If `DATABASE_URL` is set, it stays down (it doesn't exit in a loop). Otherwise it runs `initdb --auth=scram-sha-256` on first boot and starts the postgres from `postgres-init.sh` once (role and db `ucch`, `dev` role and db, `REVOKE CONNECT ON DATABASE ucch FROM PUBLIC`). It listens on `127.0.0.1` only. `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE` and `PG_WORK_MEM` are tunable, with today's defaults of 256MB, 768MB and 8MB. Readiness comes from `pg_isready` through an s6 notification-fd. |
| `mysql` | longrun | mysql | init-secrets | Starts only when `ENABLE_MYSQL=true` and `DEV_MYSQL_URL` is unset. Listens on `127.0.0.1` and applies `mysql-init.sql` once. |
| `web` | longrun | node | init-dirs | `HOSTNAME=127.0.0.1 PORT=3100 node apps/web/server.js`. |
| `server` | longrun | node (via `setpriv`) | postgres, mysql (when enabled), web | Ports the env assembly from `server-entrypoint.sh`. Hosts become `127.0.0.1` and secrets are read from `/data/secrets`. Then `exec setpriv … node apps/server/dist/server.mjs`. `PORT=3000`, `WEB_UPSTREAM=http://127.0.0.1:3100`. |

### A.3 The edge: Fastify serves the one public port

New module `apps/server/src/web-proxy.ts`, wired into the existing `serverFactory` after the preview check:

- **Ordering.** Preview Host comes first (as today). Then `/ws`, `/collab`, `/api` and `/health` are handled in-process. Then `/_next/static/*` and `/file-icons/svg/*` are served from disk with `Cache-Control: public, max-age=31536000, immutable`. Everything else is proxied to `WEB_UPSTREAM`.
- **The proxy:**
  - Uses an `undici` Pool with keep-alive.
  - Streams the response body: RSC and Suspense streaming must not be buffered.
  - Passes `Host`, `X-Forwarded-*` and cookies through, and copies response headers except hop-by-hop ones.
  - Returns a `502` page if Next is down, which is cheap and never caches.
- **Compression.** Today's `@fastify/compress` must skip proxied streaming responses (`text/x-component`, `text/html` with `Transfer-Encoding: chunked`). Next already compresses those itself (`compress: true`).
- **Why the server is the edge**, rather than Caddy or Next-in-Fastify:
  - The preview Host routing already lives here.
  - There's no extra binary or config language.
  - Next keeps its own event loop, so SSR CPU never stalls terminals or agent streams.
- **Development stays as it is.** `next dev` on :3000 with its `/api` rewrite, and the server on :3001. The edge proxy is only enabled when `WEB_UPSTREAM` is set.
- **Runtime env for Next.**
  - `SERVER_ORIGIN=http://127.0.0.1:3000` (the edge, on loopback). Requests on the loopback origin are exempt from the unsafe-method Origin check only outside production. SSR does only `GET`s, so nothing changes.
  - `NEXT_PUBLIC_WS_ORIGIN=""` so the browser uses its own host.

### A.4 Health, logs, shutdown

- `GET /health` gains `{ db: ok|error, web: ok|error }`. It checks Postgres with `select 1` and Next by fetching `HEAD /healthz` upstream, with short timeouts. The Docker `HEALTHCHECK` uses it.
- Every service logs to stdout through s6, prefixed with `[postgres]`, `[web]`, `[server]` and so on. Dokploy's log view shows them all together.
- On SIGTERM, s6 stops `server` first, which drains as today (`index.ts`, around lines 3116–3131), then `web`, then the databases with a fast-shutdown `pg_ctl stop -m fast`.

### A.5 Security inside one container

- Terminals, agents and dev servers run as `node`. That user **must not** be able to read `/data/postgres`, `/data/mysql` or `/data/secrets` (0700, owned by other users), and must not see `DATABASE_URL`. The `server` service already strips secrets from what it passes to children; verify this in `terminals.ts` and the agent bash executor.
- Databases bind to `127.0.0.1`. The `ucch` database is revoked from PUBLIC, so the `dev` role (which projects use) can't connect to it.
- `setpriv --no-new-privs --bounding-set=-all` is kept for the server and everything it spawns.

### A.6 Dokploy setup

1. Create an **Application** with Source = this repo, Build Type = **Dockerfile**, Dockerfile path `Dockerfile` and target `app`.
2. **Environment:** `ROOT_DOMAIN` is required. Everything else is optional; see `.env.example`.
3. **Domains:** `ROOT_DOMAIN` → container port **3000**, HTTPS on.
4. **Previews (optional):** add `*.ROOT_DOMAIN` → port 3000 with a DNS-01 certificate resolver. If the Dokploy version can't do wildcard domains, add the Traefik file-provider router documented in the README.
5. **Volumes:** one named volume mounted at `/data`.
6. **Advanced → Swarm → Update config: `Order: stop-first`.** This is mandatory. A start-first rollout would run two Postgres servers on the same data directory.
7. Back up the `/data` volume. For a consistent database copy, use `docker exec <ctr> ucch-backup`, a script that runs `pg_dump` into `/data/backups`.

`docker-compose.yml` shrinks to one `ucch` service built from target `app`, with the same volume and env, for local production testing and for anyone who prefers Compose. Crawl4AI stays outside the container and is turned on by setting `CRAWL4AI_URL`.

### A.7 Moving from the current Compose stack

1. `pg_dump -Fc` the old `ucch` database (and `dev`, if projects use it).
2. **Copy `secret_key` from the old `secrets` volume into the new environment as `SECRET_KEY`.** Without it, stored API keys and DB connections can't be decrypted.
3. Copy the `workspaces` and `creds` volumes into `/data/workspaces` and `/data/creds`.
4. Start the new container, run `ucch-restore <dump>`, and check sign-in, projects and keys.
5. In project `.env` files, change dev DB hosts from `postgres` and `mysql` to `127.0.0.1`.
6. **Rollback:** the old stack's volumes are untouched, so redeploy the old Compose service.

---

## 4. Part B: performance and instant navigation

### Principles

- **Paint from cache, then revalidate.** Any data seen before shows instantly, and the network only confirms or updates it.
- **No blocking at the top.** Layouts await nothing. Data streams under `Suspense` with skeletons shaped like the real UI.
- **One round trip for what every page needs.**
- **Events update data; `router.refresh()` is not a data mechanism.**
- Follow `apps/web/CLAUDE.md` and extend `navigation.test.ts` so the rules are enforced, not just documented.

### B.1 `GET /api/bootstrap`

One authenticated request returns everything the shell needs:

```ts
{
  buildId, user: { id, name, email, avatarUrl }, preferences,
  workspaces: WorkspaceSummary[], activeWorkspaceId,
  projects: ProjectSummary[], connections: ConnectionSummary[],
  quotas?: QuotaSummary, lastLocation?: string
}
```

- It replaces the four calls in `AppShell`, and `QuotaRail`'s first fetch.
- It sends `ETag` and answers `If-None-Match` with `304`.
- **Hash-addressed reads** (`GET /api/workspaces/by-hash/:hash`, `GET /api/projects/:hash`) replace "list everything, then find one" in `lib/workspace-route.ts`. That removes the per-page `listWorkspaces` waterfall.
- Check that the queries are covered by `0019_perf_indexes.sql`, and add indexes where `EXPLAIN` shows a sequential scan.

### B.2 A shell that doesn't block

- **`src/middleware.ts`** redirects to `/login?next=…` when the `ucch_session` cookie is *missing*. This is cheap and needs no network. Real validation stays on the API: a `401` anywhere sends the client to `/login`.
- **`AppShell`** renders the sidebar and header frame immediately. Data comes from the client cache, seeded by a server-side `bootstrap` under `<Suspense fallback={<SidebarSkeleton/>}>`. `SidebarSkeleton` and `HeaderSkeleton` are new, in `page-skeletons.tsx`.
- On a hard reload, the persisted cache paints the sidebar before the network answers.

### B.3 One client cache: TanStack Query v5

- **`QueryClientProvider`** sits in the root of the `(app)` layout. Defaults: `staleTime: 30s`, `gcTime: 24h`, `refetchOnWindowFocus: true`, and `retry: 1` for queries, `0` for mutations.
- **Persistence:**
  - `PersistQueryClientProvider` with `@tanstack/query-async-storage-persister` on IndexedDB (`idb-keyval`).
  - Keyed by user id. `buster` is the `buildId`. Only queries marked `meta.persist` are saved: shell lists, recent projects, sessions, and tree and list views, not file contents.
  - The cache is cleared on logout or a user switch.
- **`lib/query-keys.ts`** is a key factory, `qk.workspaces()`, `qk.projects(wsId)`, `qk.tasks(projectId)` and so on. Every hook and the realtime bridge use it.
- **Migration path.** Each `lib/*-api.ts` keeps its plain fetchers. `lib/queries/<domain>.ts` adds `use<Thing>()` and `use<Action>Mutation()` hooks. Components move from `useEffect`+`useState` to these hooks one domain at a time. Mutations use optimistic updates with rollback on error.
- **Remove `router.refresh()`** as a data path: shell lists come from queries, and `AccountRefresher` becomes the realtime bridge (Part C). `navigation.test.ts` gets an allowlist for the few legitimate uses (logout, theme cookie).

### B.4 Boot screen at sign-in

New component `components/boot-screen.tsx`, shown by `login-form.tsx` once the login `POST` succeeds. GitHub OAuth goes through a callback, so its first app page shows the same screen when the cache is empty.

1. It shows the app logo and a thin progress bar, using the colours of the theme already applied.
2. It runs these in parallel:
   - `GET /api/bootstrap`, then `queryClient.setQueryData` for each part
   - opening the shared WebSocket
   - `router.prefetch(target, { kind: FULL })`
   - prefetching the active workspace's sections, its most recent project and session, and the settings index
   - `<link rel=preload>` for the shell font and the icon sprite
   - `import()` of the core chunks: files panel and composer
3. When the bootstrap is done and the target is prefetched, or after a **2-second cap**, it calls `router.replace(target)` and fades out. Anything still running continues in the background.
4. **The target is the final URL**: `?next=` if it's safe, otherwise the `lastLocation` cookie (written on each navigation), otherwise the workspace home. There's no hop through `/` and no `refresh()`.

### B.5 Navigation guarantees

- Add a leaf `loading.tsx` to the six routes listed in §1.2. Each renders the page's skeleton from `page-skeletons.tsx`; add `NotePageSkeleton`, `ConversationSkeleton`, `SettingsSkeleton` or `TableRowsSkeleton` where missing.
- `navigation.test.ts` adds two checks:
  - every **dynamic leaf segment** has its own `loading.tsx` (not just an ancestor)
  - no `router.refresh()` outside the allowlist
- `shared/[slug]/layout.tsx` stops awaiting `fetchPublicProject`, and moves the lookup under `Suspense`.
- **Links go to final URLs.** Project links resolve the newest session from the cached session list (`lib/project-sessions.ts`) and link straight to it. The bare-URL redirect page stays only for bookmarks.
- **Router cache.** `experimental.staleTimes: { dynamic: 30, static: 300 }` in `next.config.ts`.
- **Warmup** (`components/route-warmup.tsx`, `lib/warmup.ts`):
  - re-arms after a refresh and when the tab becomes visible after more than 4 minutes
  - covers the 3 most recently used projects and their latest session/chat pages
  - runs in `requestIdleCallback` batches, and still respects Save-Data and 2G connections

### B.6 One WebSocket per tab

- `project-chat.tsx`, `terminal-view.tsx`, `login-terminal-dialog.tsx` and `lib/create-project.ts` use the `RealtimeProvider` client through `useRealtime().subscribe(topic, opts)`, instead of creating a new `UcchClient`.
- Fix the subscription dedupe in `lib/client.ts` (around line 236): it keys only on the topic, so the first subscription's `quiet` flag wins. Key on topic plus options, or upgrade to the less quiet option and downgrade when that subscription is released.

### B.7 Assets

- **Fonts.** Preload only iA Writer Mono Regular. Italic and bold load on use (`preload: false` on a second `localFont` call, or split the declaration). Keep `display: swap` with metric-matched fallbacks.
- **File icons.**
  - `GET /file-icons/resolve?names=a.ts,b.json` returns `{ name: iconId }` (cacheable).
  - Icons are served at `/file-icons/svg/<iconId>.svg` with an immutable cache.
  - The tree asks for each icon id once, so N files sharing an icon cost one request.
  - Alternatively, build a sprite of the about 60 most common icons at build time.
- **Images.** Avatars and uploads use `<img>` with explicit `width`/`height`, `loading="lazy"` and `decoding="async"`.
- **Compression.** Brotli at the edge for non-streamed responses (JSON, static files). Next compresses its own HTML and RSC.

### B.8 Bundle

- Add `@next/bundle-analyzer` (`ANALYZE=1`). Record the first-load JS of the main app routes as a baseline, then set budgets.
- Lazy-load (`dynamic()` + warmup) the pieces that aren't on the first paint:
  - `files-panel.tsx` (about 1,500 lines)
  - `QuickActions`, `TaskDialog`, `NewProjectDialog`
  - `react-markdown`, `remark-gfm` and `cmdk` (when not visible)
  - the `@codemirror/language` highlighter used by diff and public documents
- `experimental.optimizePackageImports` for `lucide-react` and `@base-ui/react`.

### B.9 Server-side

- **SSR to API.**
  - `lib/session.ts` fetchers use one shared `undici` `Agent` with keep-alive (`fetch(url, { dispatcher })`).
  - React `cache()` dedupes reads within a request.
  - In the single container this traffic stays on loopback.
- **Precompiled server bundle** (A.1).
- **Database.** Run `EXPLAIN ANALYZE` on bootstrap, the session list, tasks and notes, and add indexes as needed.

### B.10 Measurement

- **Real-user metrics.** `web-vitals` sends LCP, INP, CLS, TTFB and a custom "nav→skeleton" and "nav→content" to `POST /api/metrics/vitals`. These are stored in a small table and shown in an admin view later.
- **Lab tests.** A Playwright suite (`apps/web/e2e/perf.spec.ts`) runs against `next build && next start` with `DEV_AUTH_BYPASS`:
  - login → shell
  - home → project → session → session B → tasks → documentation → note B → settings pages
- **Budgets** (definition of done):

| Metric | Target |
|---|---|
| Click → skeleton or new page painted | ≤ 100 ms (p95, lab) |
| Click → content, data already cached | ≤ 150 ms |
| Click → content, cold data | ≤ 600 ms on loopback |
| Login submit → interactive shell | ≤ 2.0 s (hard cap on the boot screen) |
| Hard reload of an app page → sidebar painted | ≤ 300 ms (from persisted cache) |
| First-load JS on the app shell route | baseline −25% |
| WebSocket connections per tab | 1, plus 1 per open co-edited document |

---

## 5. Part C: everything live

### Principles

- **Security first:** no event reaches someone who couldn't fetch the same data.
- Events are **small facts with the changed entity**, so clients patch their cache. A refetch nudge is the fallback for large payloads.
- **One bridge** maps events to the cache; components don't each register their own listeners for data.
- **Reconnects are not data loss:** after a reconnect, clients resync.

### C.1 Security fixes (before new broadcasts)

1. Stop publishing `terminal.output` to the project topic (`bus.ts`, around line 65, and its caller in `index.ts`). Only the `terminal:{id}` topic gets terminal bytes.
2. ACL on `subscribe(terminal)`: only the terminal's owner, or a workspace member when the terminal is explicitly shared (`ws.ts`, around line 220).
3. Revoke access:
   - On member removal, project delete, workspace delete or logout, the server drops the cached access entry (`ws.ts`, around line 391) and force-unsubscribes affected connections, sending a `subscription.revoked` push.
   - Logout closes the user's sockets.
4. Tests for each of the above in `ws` and `bus` tests.

### C.2 A `workspace:{id}` topic

- Add `workspace` to the protocol's `Topic` union (`packages/protocol`), to `EventBus.publishToWorkspace` and to the gateway's subscribe ACL (any member).
- `RealtimeProvider` auto-subscribes to the active workspace and switches the subscription when the workspace changes.
- `route-audit.ts` gains scope `"workspace"`, which these move to:
  - project create, delete and rename
  - workspace update, archive and delete
  - members and invites
  - credential policy
  - database connections and database-manager data changes
- A user's profile change (name, avatar) fans out to each workspace they're in.
- An added or removed member is told on `user:{id}`, so their workspace list updates.
- `project.created` is also published to the workspace topic (today it only lands on the new project's own topic).

### C.3 The realtime → cache bridge

- `lib/realtime-cache.ts` is one switch over event types that calls `queryClient.setQueryData` (when the event carries the entity) or `invalidateQueries` (when it doesn't), using `lib/query-keys.ts`.
- Events gain small payloads where they're cheap: `task.changed` carries the task, `timeline.changed` the item, `member.changed` the member. `note.changed` keeps its up-to-256 KB rule.
- Unit-test the mapping table.

### C.4 Resync after reconnect

- **Phase 1.** On `ready` after a drop, invalidate every active query (TanStack refetches only what's mounted) and re-send presence.
- **Phase 2.** Durable project-level events get a per-project sequence, and the gateway replays `sinceSeq` for `project` topics as it already does for threads (`ws.ts`, around line 251).

### C.5 Fill in the missing events

| Where | Add |
|---|---|
| `git-routes.ts` remote PUT/DELETE, fetch | `resource.changed{git}` / `git.fetched` to the project topic |
| Diagram generation (`index.ts` `runDiagramJob`) | Job state goes into a store and is published as `diagram.job{kind,state}`; GET polling becomes the fallback |
| Preview publish and port detection (`preview.ts`, `decide.ts`) | Emit the already-defined `preview.published`, `port.opened` and `port.closed` |
| Upload delete and attach | `upload.changed`; `file.changed` with origin `"system"` |
| `file.changed` | Add `worktreeId`/`sessionId`. `files-panel.tsx` handles events with no origin |
| `route-audit.ts` | Add the task routes to `SELF_AUDITED` (they're currently logged twice) |

### C.6 File watcher

- New `apps/server/src/file-watcher.ts` using `@parcel/watcher`, which is native, recursive and efficient.
- It runs one watcher per project (and per worktree) **while that project has at least one subscriber**, and stops 60 seconds after the last one leaves.
- It ignores `.git`, `node_modules`, `vendor`, `.next`, `dist` and `.ucch/cache`.
- Changes are coalesced over 150 ms and sent as `file.changed{origin: "fs"}`. Writes the server made itself (REST, agent) are recognised by version and not echoed again.
- The git status view refreshes on these events, which makes the 10-second poll a 60-second safety net.

### C.7 Real-time co-editing (Yjs)

**Server**
- **Hocuspocus v3** (`@hocuspocus/server`) is embedded in the Fastify process on the `/collab` upgrade path. It doesn't open its own port: it uses `hocuspocus.handleConnection(ws, req)`.
- **Auth.** `onAuthenticate` takes the same single-use ws-ticket plus a `ProjectAccess.canAccessProject` check. The document name is `note:{noteId}` (later `file:{projectId}:{path}`).
- **Persistence.**
  - New table `note_ydocs(note_id uuid pk references notes on delete cascade, state bytea, updated_at)`.
  - `onLoadDocument` reads the stored state. When there's none, it builds the doc from the note's existing `content` (markdown → ProseMirror JSON → Y.XmlFragment) the first time.
  - `onStoreDocument` (debounced 2 s, max 10 s) saves the state **and projects it back to `notes.content`** as markdown. Search, the agent's documentation tools, public pages and exports keep reading `content` unchanged.
- **Server-side writers.** The agent and REST `PATCH /notes/:id` content updates apply as a Yjs transaction on the live doc (`openDirectConnection`), so open editors merge the change instead of being overwritten.
- **Memory.** Documents unload after 30 seconds with no connections. Log the number of open docs in `/health`.

**Client**
- In `note-editor-impl.tsx`, use `@tiptap/extension-collaboration` and `@tiptap/extension-collaboration-caret`, with `@hocuspocus/provider` connected to `/collab`. StarterKit's history is turned off (Yjs undo replaces it).
- Name and colour come from presence (C.8).
- Remove the whole-document `note.changed` content swap, `lib/note-autosave.ts` saves and `ifUpdatedAt` 409 handling for content. Title, icon and cover stay REST plus events.

**Phase 2: code files and diagrams**
- `y-codemirror.next` in the CodeMirror editor (`code-editor.tsx`, `diagram-editor.tsx`), with doc `file:{projectId}:{worktree}:{path}`.
- The disk stays the source of truth. The server writes the doc back to disk (debounced 1 s, using `workspaceFiles.write`). Watcher changes from outside (agent, terminal, git checkout) are applied into the doc as the smallest edit, reusing the prefix/suffix diff idea in `apps/web/src/lib/doc-sync.ts`, moved to `packages/protocol` so both sides share it.

### C.8 Presence with real people

- Presence entries carry `{ userId, name, avatarUrl, color }`. The colour is stable per user (`lib/selection-color.ts`).
- `presence-badge.tsx` shows a stack of avatars with names on hover, instead of "another window". One's own other tabs are folded into a single entry.
- Presence locations are added to code (file path), tasks (board/task id), timeline, DB manager (table) and git.
- Editors show remote cursors and selections through Yjs awareness (C.7).

### C.9 Concurrency and optimistic UI

- Every mutation hook (B.3) updates the cache optimistically, rolls back on error and reconciles with the server's response or event.
- **Tasks and timeline:** per-field patches (`PATCH` with only the changed fields), so two people editing different fields don't overwrite each other.
- **DB-manager row edits:** send the row's original values as a precondition (`WHERE` on primary key plus the changed columns' old values). If 0 rows are affected, return `409` and show a conflict toast with "reload row".

### C.10 The bus stays in-process

The container runs one server process, so `EventBus` stays in memory. Its interface (`subscribe`, `publish`, `publishToUser`, plus `publishToWorkspace`) is the seam if Postgres `LISTEN/NOTIFY` is ever needed.

---

## 6. Part D: PWA groundwork

- **Manifest.** `app/manifest.ts` with name, short name, `start_url: "/"`, `display: "standalone"` and theme and background colours. Icons at 192, 512 and 512-maskable, plus `apple-icon` at 180×180 (replacing the 662 B file). The root layout exports a `viewport` with `themeColor`.
- **Static shell.**
  - Move the theme from a server `cookies()` read in `app/layout.tsx` to a static default plus a client-applied theme. Keep honouring the cookie with a tiny inline `<style>` that the middleware emits through a header, or accept a one-frame theme apply.
  - This makes `/login` and the offline page static and precacheable.
  - `app/layout.tsx` carries detailed hydration warnings (one `<body>` child, no authored `<head>`); keep to them.
- **Service worker: Serwist** (`@serwist/next`, webpack build), enabled when `NEXT_PUBLIC_PWA=1`.
  - **Precache:** the app shell route, core chunks, fonts, the icon sprite and `/offline`.
  - **Runtime:**
    - `/_next/static/*` is cache-first (immutable).
    - `/file-icons/svg/*` is stale-while-revalidate.
    - Navigations are network-first with a 3-second timeout, falling back to the cached shell and then `/offline`.
    - RSC requests are network-only.
  - **Never cached:** `/api/*`, `/ws`, `/collab` and preview hosts. Data comes from the IndexedDB query cache (B.3), which is what makes an installed app open instantly.
  - **"Load only the important part":** editors and heavy chunks are precached lazily, on first use or by warmup, not at install.
- **Updates.** The service worker activates on the next load. When a new `buildId` arrives (from bootstrap), show a "New version available — Reload" toast.
- **Install prompt.** Capture `beforeinstallprompt` and show an "Install app" entry in the user menu.

---

## 7. Rollout order

| Phase | Contents | Why this order |
|---|---|---|
| **P0** | Checkpoint commit of the current work, fix the `runDiagramJob` bug, baseline metrics, Playwright harness | Measure before optimising; start from a clean tree |
| **S** | Realtime security fixes (C.1) | Must land before more data is broadcast |
| **D** | Single container (Part A) | Independent of the UI work; unblocks the simple deploy |
| **B-core** | Bootstrap endpoint, middleware gate, streaming shell, TanStack Query and persister, leaf loading boundaries, boot screen | Gives instant navigation, and is the base for live cache updates |
| **R-core** | Workspace topic, realtime bridge, reconnect resync, missing events, file watcher, presence | "Everything live" on top of the cache |
| **B-rest** | One socket, warmup, fonts and icons, bundle splitting, SSR keep-alive, web-vitals | Polish and budgets |
| **R-collab** | Hocuspocus and notes co-editing, then code and diagram co-editing | Largest change; needs the bridge and presence |
| **W** | Manifest, static shell, Serwist behind a flag, offline page, update prompt | Builds on the persisted cache and static shell |

Every phase ends green on `pnpm typecheck`, `pnpm test`, a production web build and (from phase D on) the container smoke test.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Embedded Postgres plus a rolling deploy corrupts data | `stop-first` update order (documented in A.6, checked in the README); Postgres's `postmaster.pid` lock |
| Losing the database with the container | One `/data` volume; `ucch-backup` script; README backup section |
| Larger image (Postgres and MariaDB added to an already large doc-kit image) | MariaDB is optional; the precompiled server drops devDependencies; consider a `DOC_KIT=0` build arg later |
| Single point of failure (one container) | Accepted by design. The server was already a single replica, so web replicas added little |
| Next behind the edge proxy breaks streaming | Streaming proxy with no compression on proxied responses; a Playwright check that Suspense boundaries stream |
| Hocuspocus memory with many open docs | Unload after 30 s with no connections; open-doc count in `/health` |
| Persisted cache shows stale or other-user data | Keyed by user id, `buster = buildId`, cleared on logout; revalidates on mount |
| Serwist and App Router edge cases | Behind `NEXT_PUBLIC_PWA`; never caches RSC or `/api` |
| Large uncommitted working tree | P0 checkpoint commit before any task starts |
