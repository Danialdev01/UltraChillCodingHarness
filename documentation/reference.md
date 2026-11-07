# UCCH reference

A lookup reference for every interface and module: HTTP routes, the WebSocket protocol, commands, events, server modules, packages, web modules, scripts and commands. What features *do* is in [`spec.md`](./spec.md). How they fit together is in [`architecture.md`](./architecture.md). Configuration variables are in [architecture §10](./architecture.md#10-configuration).

Paths are relative to the repository root. "Source" columns point to where a thing is defined.

Contents: [HTTP API](#http-api) · [WebSocket protocol](#websocket-protocol) · [Commands](#commands) · [Events](#events) · [Server modules](#server-modules) · [Packages](#packages) · [Web app](#web-app) · [Agent tools](#agent-tools) · [Scripts and commands](#scripts-and-commands)

---

## HTTP API

Every `/api` route except `auth/*`, `public/*` (rate-limited per address), `internal/*` (loopback with the collab secret) and `metrics/vitals` needs a session cookie. Project routes (`/api/projects/:hash/...`) answer 404 unless the caller is a member of the project's workspace. Writes then check the role's permission (`project.write`, `workspace.manage`, …). Project file, git and search routes take `?session=<hash>` to act on a session's worktree instead of the project's checkout. Successful writes are recorded in the activity log (`apps/server/src/route-audit.ts`) and announced to other tabs.

### Auth and account

| Method | Path | Purpose | Source |
|---|---|---|---|
| PUT | `/api/account/avatar` | set the avatar (`data:` URL) | `index.ts:1208` |
| PUT | `/api/account/email` | change email | `index.ts:1144` |
| PUT | `/api/account/name` | change display name | `index.ts:1127` |
| GET | `/api/account/openrouter/quota` | OpenRouter key spend/limit | `index.ts:3265` |
| PUT | `/api/account/password` | change password (current one required) | `index.ts:1177` |
| GET | `/api/account/quotas` | Claude, Codex and OpenRouter usage meters | `index.ts:3301` |
| GET | `/api/activity` | the account's activity feed | `index.ts:2001` |
| GET | `/api/auth/github` | start GitHub OAuth | `index.ts:3912` |
| GET | `/api/auth/github/callback` | finish GitHub OAuth | `index.ts:3945` |
| POST | `/api/auth/login` | password sign-in (20/min/address) | `index.ts:3878` |
| POST | `/api/auth/logout` | end the session | `index.ts:4038` |
| GET | `/api/bootstrap` | the shell's data: user, workspaces, projects, settings | `index.ts:1041` |
| GET | `/api/me` | the signed-in user | `index.ts:1091` |
| POST | `/api/metrics/vitals` | browser web-vitals beacon (60/min) | `index.ts:993` |
| GET | `/api/models` | OpenRouter model catalogue (cached) | `index.ts:3759` |
| GET | `/api/omp-memory/:projectId` | OMP memory counts / clear | `omp-memory-routes.ts:50` |
| DELETE | `/api/omp-memory/:projectId` | OMP memory counts / clear | `omp-memory-routes.ts:64` |
| GET | `/api/providers` | provider cards: installed, signed in, version | `index.ts:3575` |
| DELETE | `/api/providers/:id/credentials` | sign a CLI out | `index.ts:3640` |
| GET | `/api/settings` | the account's settings (keys shown as set/unset) | `index.ts:3381` |
| PUT | `/api/settings/agent-permission-mode` | strict / normal / allow_all | `index.ts:3435` |
| PUT | `/api/settings/claude-token` | paste a Claude Code OAuth token | `index.ts:3609` |
| PUT | `/api/settings/default-model` | default model | `index.ts:3549` |
| PUT | `/api/settings/default-provider` | default provider | `index.ts:3662` |
| PUT | `/api/settings/{openrouter,resend,github}` | older key route for scripts: stores without the live check | `account-keys-routes.ts` |
| GET | `/api/account/keys` | key metadata (prefix, last four, dates, scopes), never a value | `account-keys-routes.ts` |
| PUT | `/api/account/keys/:provider` | format check, live check against the provider, store | `account-keys-routes.ts` |
| DELETE | `/api/account/keys/:provider` | remove a stored key | `account-keys-routes.ts` |
| POST | `/api/account/reauth` | password step-up for this session, five minutes; 5 tries / 10 min | `account-keys-routes.ts` |
| POST | `/api/account/keys/:provider/reveal` | one key in the clear after a step-up; logged to Activity; 10 / 10 min | `account-keys-routes.ts` |
| POST | `/api/ws-ticket` | single-use ticket for the `/ws` upgrade | `index.ts:1230` |

### Workspaces and members

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/api/invites/:token` | what an invite link offers | `workspace-members-routes.ts:164` |
| POST | `/api/invites/:token/accept` | join by invite | `workspace-members-routes.ts:172` |
| GET | `/api/workspaces` | list / create workspaces | `index.ts:1240` |
| POST | `/api/workspaces` | list / create workspaces | `index.ts:1249` |
| PATCH | `/api/workspaces/:id` | rename, archive, restore / delete (when empty) | `index.ts:1296` |
| DELETE | `/api/workspaces/:id` | rename, archive, restore / delete (when empty) | `index.ts:1325` |
| PUT | `/api/workspaces/:id/credentials/:kind` | set or clear the workspace's OpenRouter key or Claude token | `workspace-members-routes.ts:209` |
| GET | `/api/workspaces/:id/database-connections` | list / add connections (tested on save) | `database-routes.ts:41` |
| POST | `/api/workspaces/:id/database-connections` | list / add connections (tested on save) | `database-routes.ts:53` |
| GET | `/api/workspaces/:id/invites` | list / create invite links | `workspace-members-routes.ts:129` |
| POST | `/api/workspaces/:id/invites` | list / create invite links | `workspace-members-routes.ts:138` |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | revoke an invite | `workspace-members-routes.ts:149` |
| GET | `/api/workspaces/:id/members` | list / add members | `workspace-members-routes.ts:81` |
| POST | `/api/workspaces/:id/members` | list / add members | `workspace-members-routes.ts:90` |
| PATCH | `/api/workspaces/:id/members/:userId` | change role or permissions / remove | `workspace-members-routes.ts:101` |
| DELETE | `/api/workspaces/:id/members/:userId` | change role or permissions / remove | `workspace-members-routes.ts:115` |
| GET | `/api/workspaces/:id/projects` | the workspace's projects | `index.ts:1342` |
| GET | `/api/workspaces/:id/settings` | credential policy and agent settings | `workspace-members-routes.ts:182` |
| PATCH | `/api/workspaces/:id/settings` | credential policy and agent settings | `workspace-members-routes.ts:191` |
| GET | `/api/workspaces/:id/stats` | dashboard figures | `index.ts:1360` |
| GET | `/api/workspaces/:id/storage` | bytes per project | `index.ts:1392` |
| GET | `/api/workspaces/:id/usage` | tokens and cost by person, project, model | `index.ts:1376` |
| GET | `/api/workspaces/by-hash/:hash` | resolve a workspace address | `index.ts:1285` |

### Projects

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/api/projects/:hash` | a project (read, rename, delete) | `index.ts:1419` |
| PATCH | `/api/projects/:hash` | a project (read, rename, delete) | `index.ts:1577` |
| DELETE | `/api/projects/:hash` | a project (read, rename, delete) | `index.ts:1595` |
| GET | `/api/projects/:hash/activity` | the project's activity feed | `index.ts:1982` |
| POST | `/api/projects/:hash/diagrams/:kind/generate` | generate a diagram from the codebase / its job state | `index.ts:2847` |
| GET | `/api/projects/:hash/diagrams/:kind/generate` | generate a diagram from the codebase / its job state | `index.ts:2878` |
| GET | `/api/projects/:hash/file` | read / save / create / rename-move / delete a file | `index.ts:2640` |
| PUT | `/api/projects/:hash/file` | read / save / create / rename-move / delete a file | `index.ts:2746` |
| POST | `/api/projects/:hash/file` | read / save / create / rename-move / delete a file | `index.ts:2897` |
| DELETE | `/api/projects/:hash/file` | read / save / create / rename-move / delete a file | `index.ts:2926` |
| PATCH | `/api/projects/:hash/file` | read / save / create / rename-move / delete a file | `index.ts:2961` |
| GET | `/api/projects/:hash/file/raw` | file bytes under an extension-derived type, sandboxed | `index.ts:2695` |
| GET | `/api/projects/:hash/files` | the file tree | `index.ts:2632` |
| POST | `/api/projects/:hash/git/stage` | stage paths | `git-routes.ts:226` |
| POST | `/api/projects/:hash/git/unstage` | unstage paths | `git-routes.ts:226` |
| GET | `/api/projects/:hash/git/branches` | list / create branches | `git-routes.ts:215` |
| POST | `/api/projects/:hash/git/branches` | list / create branches | `git-routes.ts:296` |
| POST | `/api/projects/:hash/git/checkout` | switch branch | `git-routes.ts:282` |
| POST | `/api/projects/:hash/git/commit` | commit staged changes | `git-routes.ts:256` |
| GET | `/api/projects/:hash/git/commits/:sha` | one commit | `git-routes.ts:191` |
| GET | `/api/projects/:hash/git/commits/:sha/diff` | a commit's diff | `git-routes.ts:201` |
| GET | `/api/projects/:hash/git/diff` | working-tree diff of a file | `git-routes.ts:167` |
| POST | `/api/projects/:hash/git/discard` | discard changes | `git-routes.ts:241` |
| POST | `/api/projects/:hash/git/fetch` | fetch from the remote | `git-routes.ts:311` |
| GET | `/api/projects/:hash/git/log` | history (paged) | `git-routes.ts:177` |
| POST | `/api/projects/:hash/git/merge/abort` | abort a merge | `git-routes.ts:434` |
| POST | `/api/projects/:hash/git/pull` | pull | `git-routes.ts:325` |
| POST | `/api/projects/:hash/git/push` | push | `git-routes.ts:338` |
| POST | `/api/projects/:hash/git/remote` | the `origin` remote (read, add + join histories, repoint, remove) | `git-routes.ts:351` |
| GET | `/api/projects/:hash/git/remote` | the `origin` remote (read, add + join histories, repoint, remove) | `git-routes.ts:381` |
| PUT | `/api/projects/:hash/git/remote` | the `origin` remote (read, add + join histories, repoint, remove) | `git-routes.ts:390` |
| DELETE | `/api/projects/:hash/git/remote` | the `origin` remote (read, add + join histories, repoint, remove) | `git-routes.ts:405` |
| POST | `/api/projects/:hash/git/resolve` | resolve a conflicted file (ours/theirs/mark) | `git-routes.ts:420` |
| GET | `/api/projects/:hash/git/status` | status (cached per tree) | `git-routes.ts:158` |
| GET | `/api/projects/:hash/keys` | list (no values) / create keys | `keys-routes.ts:56` |
| POST | `/api/projects/:hash/keys` | list (no values) / create keys | `keys-routes.ts:63` |
| PATCH | `/api/projects/:hash/keys/:keyId` | change / delete a key | `keys-routes.ts:72` |
| DELETE | `/api/projects/:hash/keys/:keyId` | change / delete a key | `keys-routes.ts:84` |
| GET | `/api/projects/:hash/keys/:keyId/value` | reveal one key's value | `keys-routes.ts:93` |
| GET | `/api/projects/:hash/notes` | the page tree / create a page | `notes-routes.ts:126` |
| POST | `/api/projects/:hash/notes` | the page tree / create a page | `notes-routes.ts:133` |
| GET | `/api/projects/:hash/notes/:noteId` | read / change / delete a page | `notes-routes.ts:208` |
| PATCH | `/api/projects/:hash/notes/:noteId` | read / change / delete a page | `notes-routes.ts:219` |
| DELETE | `/api/projects/:hash/notes/:noteId` | read / change / delete a page | `notes-routes.ts:367` |
| POST | `/api/projects/:hash/notes/:noteId/move` | move a page in the tree | `notes-routes.ts:323` |
| POST | `/api/projects/:hash/notes/assets` | upload an image for a page | `notes-routes.ts:162` |
| GET | `/api/projects/:hash/notes/search` | search pages by text | `notes-routes.ts:197` |
| GET | `/api/projects/:hash/omp-trust` | whether OMP trusts the repository (change: `workspace.manage`) | `index.ts:2576` |
| PATCH | `/api/projects/:hash/omp-trust` | whether OMP trusts the repository (change: `workspace.manage`) | `index.ts:2584` |
| PUT | `/api/projects/:hash/preview` | set the preview port or folder | `index.ts:1469` |
| GET | `/api/projects/:hash/preview/open` | mint a preview ticket and redirect to the preview host | `index.ts:1566` |
| GET | `/api/projects/:hash/preview/open/*` | same, landing on a path | `index.ts:1567` |
| GET | `/api/projects/:hash/preview/status` | is the dev server up | `index.ts:1510` |
| GET | `/api/projects/:hash/public` | the public site (state / toggle) | `index.ts:2551` |
| PATCH | `/api/projects/:hash/public` | the public site (state / toggle) | `index.ts:2559` |
| POST | `/api/projects/:hash/replace` | replace ticked search matches | `index.ts:1746` |
| GET | `/api/projects/:hash/reviews` | OMP code reviews | `review-routes.ts:28` |
| GET | `/api/projects/:hash/search` | ripgrep search | `index.ts:1678` |
| DELETE | `/api/projects/:hash/sessions/:sessionHash` | remove a session (`?ifEmpty=1`) | `index.ts:3819` |
| GET | `/api/projects/:hash/stats` | the project's figures | `index.ts:1406` |
| GET | `/api/projects/:hash/task-settings` | Tasks-board agent and Auto Run schedule | `tasks-routes.ts:312` |
| PUT | `/api/projects/:hash/task-settings` | Tasks-board agent and Auto Run schedule | `tasks-routes.ts:320` |
| GET | `/api/projects/:hash/tasks` | list / create cards | `tasks-routes.ts:136` |
| POST | `/api/projects/:hash/tasks` | list / create cards | `tasks-routes.ts:142` |
| PATCH | `/api/projects/:hash/tasks/:taskId` | change (per-field guarded) / delete a card | `tasks-routes.ts:161` |
| DELETE | `/api/projects/:hash/tasks/:taskId` | change (per-field guarded) / delete a card | `tasks-routes.ts:287` |
| POST | `/api/projects/:hash/tasks/:taskId/feedback` | answer a failed verification | `tasks-routes.ts:228` |
| POST | `/api/projects/:hash/tasks/:taskId/move` | move a card (stage, position) | `tasks-routes.ts:188` |
| POST | `/api/projects/:hash/tasks/:taskId/retry` | retry a failed card | `tasks-routes.ts:269` |
| GET | `/api/projects/:hash/threads` | the project's sessions | `index.ts:3783` |
| GET | `/api/projects/:hash/timeline/tasks` | list / create Gantt tasks | `timeline-routes.ts:102` |
| POST | `/api/projects/:hash/timeline/tasks` | list / create Gantt tasks | `timeline-routes.ts:108` |
| PATCH | `/api/projects/:hash/timeline/tasks/:taskId` | change / delete a Gantt task | `timeline-routes.ts:137` |
| DELETE | `/api/projects/:hash/timeline/tasks/:taskId` | change / delete a Gantt task | `timeline-routes.ts:183` |
| GET | `/api/projects/:hash/uploads` | list / stage attachments | `index.ts:3075` |
| POST | `/api/projects/:hash/uploads` | list / stage attachments | `index.ts:3081` |
| DELETE | `/api/projects/:hash/uploads/:id` | discard an attachment | `index.ts:3241` |
| POST | `/api/projects/:hash/uploads/:id/attach` | place an attachment in the tree | `index.ts:3215` |
| GET | `/api/projects/:hash/uploads/:id/content` | an attachment's bytes | `index.ts:3130` |
| GET | `/api/projects/:hash/uploads/:id/text` | an attachment's extracted text | `index.ts:3176` |

### GitHub and remotes

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/api/git/refs` | branches of a remote URL (`ls-remote`) | `index.ts:1650` |
| GET | `/api/github/repos` | repositories the token can see | `index.ts:3707` |
| GET | `/api/github/repos/:owner/:repo/branches` | a repository's branches | `index.ts:3733` |

### Databases

| Method | Path | Purpose | Source |
|---|---|---|---|
| PATCH | `/api/database-connections/:id` | a saved connection (read, change, remove) | `database-routes.ts:103` |
| DELETE | `/api/database-connections/:id` | a saved connection (read, change, remove) | `database-routes.ts:213` |
| GET | `/api/database-connections/:id` | a saved connection (read, change, remove) | `database-routes.ts:89` |
| GET | `/api/database-connections/:id/databases` | list / create databases on the server | `database-routes.ts:192` |
| POST | `/api/database-connections/:id/databases` | list / create databases on the server | `database-routes.ts:199` |
| DELETE | `/api/database-connections/:id/databases/:db` | drop a database | `database-routes.ts:206` |
| GET | `/api/database-connections/:id/db/:db/export` | stream a SQL or CSV dump | `db-manager-routes.ts:245` |
| POST | `/api/database-connections/:id/db/:db/import` | run a SQL script or import CSV | `db-manager-routes.ts:269` |
| POST | `/api/database-connections/:id/db/:db/sql` | run SQL, a result per statement | `db-manager-routes.ts:236` |
| GET | `/api/database-connections/:id/db/:db/tables` | list / create tables | `db-manager-routes.ts:125` |
| POST | `/api/database-connections/:id/db/:db/tables` | list / create tables | `db-manager-routes.ts:137` |
| GET | `/api/database-connections/:id/db/:db/tables/:table` | describe / alter / drop a table | `db-manager-routes.ts:129` |
| PATCH | `/api/database-connections/:id/db/:db/tables/:table` | describe / alter / drop a table | `db-manager-routes.ts:144` |
| DELETE | `/api/database-connections/:id/db/:db/tables/:table` | describe / alter / drop a table | `db-manager-routes.ts:151` |
| POST | `/api/database-connections/:id/db/:db/tables/:table/columns` | add a column | `db-manager-routes.ts:165` |
| PATCH | `/api/database-connections/:id/db/:db/tables/:table/columns/:column` | change / drop a column | `db-manager-routes.ts:172` |
| DELETE | `/api/database-connections/:id/db/:db/tables/:table/columns/:column` | change / drop a column | `db-manager-routes.ts:183` |
| GET | `/api/database-connections/:id/db/:db/tables/:table/create-sql` | the CREATE statement | `db-manager-routes.ts:133` |
| POST | `/api/database-connections/:id/db/:db/tables/:table/indexes` | add an index | `db-manager-routes.ts:190` |
| DELETE | `/api/database-connections/:id/db/:db/tables/:table/indexes/:index` | drop an index | `db-manager-routes.ts:197` |
| GET | `/api/database-connections/:id/db/:db/tables/:table/rows` | browse / insert / update / delete rows (conflict-checked) | `db-manager-routes.ts:206` |
| POST | `/api/database-connections/:id/db/:db/tables/:table/rows` | browse / insert / update / delete rows (conflict-checked) | `db-manager-routes.ts:210` |
| PATCH | `/api/database-connections/:id/db/:db/tables/:table/rows` | browse / insert / update / delete rows (conflict-checked) | `db-manager-routes.ts:217` |
| DELETE | `/api/database-connections/:id/db/:db/tables/:table/rows` | browse / insert / update / delete rows (conflict-checked) | `db-manager-routes.ts:230` |
| POST | `/api/database-connections/:id/db/:db/tables/:table/truncate` | empty a table | `db-manager-routes.ts:158` |
| GET | `/api/database-connections/:id/db/:db/users` | list / create users or roles | `db-manager-routes.ts:302` |
| POST | `/api/database-connections/:id/db/:db/users` | list / create users or roles | `db-manager-routes.ts:306` |
| DELETE | `/api/database-connections/:id/db/:db/users/:name` | drop a user | `db-manager-routes.ts:314` |
| POST | `/api/database-connections/:id/db/:db/users/:name/grant` | grant privileges | `db-manager-routes.ts:323` |
| POST | `/api/database-connections/:id/db/:db/users/:name/revoke` | revoke privileges | `db-manager-routes.ts:323` |

### Public sites

| Method | Path | Purpose | Source |
|---|---|---|---|
| GET | `/api/public/:slug` | a public site's project | `public-routes.ts:47` |
| GET | `/api/public/:slug/file` | one file | `public-routes.ts:101` |
| GET | `/api/public/:slug/files` | the file tree | `public-routes.ts:94` |
| GET | `/api/public/:slug/log` | git history | `public-routes.ts:129` |
| GET | `/api/public/:slug/notes` | the page tree | `public-routes.ts:53` |
| GET | `/api/public/:slug/notes/:noteId` | one page | `public-routes.ts:60` |
| GET | `/api/public/:slug/uploads/:id/content` | an image in a page | `public-routes.ts:71` |

### Internal and operations

| Method | Path | Purpose | Source |
|---|---|---|---|
| POST | `/api/internal/collab/authorize` | collab → API: redeem ticket, check access (loopback + secret) | `index.ts:2228` |
| POST | `/api/internal/collab/files/read` | collab → API: read a file to open it | `index.ts:2301` |
| POST | `/api/internal/collab/files/write` | collab → API: write a co-edited file back | `index.ts:2323` |
| POST | `/api/internal/collab/saved` | collab → API: a note was saved | `index.ts:2266` |
| GET | `/health` | status, DB and web reachability | `index.ts:1007` |
| GET | `/metrics` | Prometheus metrics (loopback or `METRICS_TOKEN`) | `index.ts:973` |

### Non-API paths served by the server

| Path | What |
|---|---|
| `GET /ws?ticket=&client=&caps=` | the WebSocket gateway (below) |
| `GET /collab` (upgrade) | passed through to the Hocuspocus service |
| `p{port}-{hash}.<ROOT_DOMAIN>/*` | live-preview reverse proxy (HTTP and WebSocket), before any route |
| `/{hash}/preview[/*]` | the web app's alias that sends you on to the preview host |
| `/_next/static/*`, `/sw.js` | static files from the web build |
| everything else | streamed to the Next.js server |

### Web app routes (`apps/web/src/app`)

| Route | Page |
|---|---|
| `/` | workspaces (home) |
| `/login` | sign in |
| `/invite/[token]` | accept an invite |
| `/setting`, `/setting/[page]` | account settings: `account`, `api`, `providers`, `usage`, `activity`, `theme` |
| `/[ws]` | workspace dashboard |
| `/[ws]/code` | projects table |
| `/[ws]/p/[project]` | project chat (first session) |
| `/[ws]/p/[project]/[sessionHash]` | a session |
| `/[ws]/p/[project]/documentation[/[noteId]]` | notes, diagrams, references, environment variables (`?view=`) |
| `/[ws]/p/[project]/tasks` | Tasks board |
| `/[ws]/p/[project]/timeline` | Gantt timeline |
| `/[ws]/p/[project]/keys` | project keys |
| `/[ws]/p/[project]/activity` | project activity |
| `/[ws]/p/[project]/manage` | figures, git, activity, project key, preferences (`?tab=`) |
| `/[ws]/s/[sessionHash]` | a session in a session workspace |
| `/[ws]/database[/[connectionId][/[db][/[table]]]]` | database manager |
| `/[ws]/workspace-settings[/[page]]` | `general`, `members`, `sharing`, `harness` |
| `/[ws]/publish`, `/[ws]/todo` | placeholders |
| `/[ws]/[...legacy]` | old bookmarks, redirected |
| `/shared/[slug]`, `/shared/[slug]/notes/[[...noteId]]`, `/shared/[slug]/documents`, `/shared/[slug]/timeline` | public site |
| `/offline` | offline page (PWA) |
| `/healthz` | web health |
| `/file-icons`, `/file-icons/resolve`, `/file-icons/svg/[id]` | file-type icon service |
| `/dev/themes` | theme playground (development) |

---

## WebSocket protocol

Defined in `packages/protocol/src/rpc.ts`, served by `apps/server/src/ws.ts`. Get a ticket with `POST /api/ws-ticket`, then open `/ws?ticket=<t>&client=<tabId>&caps=<comma list>`. Capabilities include `replay-batch`. One socket per tab.

**Client → server frames**

| `kind` | Fields | Meaning |
|---|---|---|
| `dispatch` | `id`, `command` | run a [command](#commands); answered by `ack` or `error` |
| `subscribe` | `id`, `topic` | `{name:"user"}`, `{name:"workspace",workspaceId}`, `{name:"project",projectId, streams?}`, `{name:"thread",threadId, sinceSeq?}`, `{name:"terminal",terminalId}` |
| `unsubscribe` | `id`, `subscriptionId` | stop a subscription |
| `composer` | thread id, state, `baseRev` | update the shared prompt box |
| `presence` | project, location, typing | where this tab is |
| `terminal_input` | `terminalId`, `data` | keystrokes (fast path, no engine) |
| `terminal_resize` | `terminalId`, `cols`, `rows` | resize (fast path) |
| `ping` | | keep-alive |

**Server → client frames**

| `kind` | Meaning |
|---|---|
| `ready` | the socket is authenticated |
| `ack` | a `dispatch` or `subscribe` succeeded (with the subscription id) |
| `error` | a frame was refused (`invalid`, `forbidden`, `not_found`, `conflict`, `internal`, …) |
| `push` | one event on a subscription |
| `replay` | a batch of a thread's recent events on subscribe |
| `pong` | answer to `ping` |
| `revoked` | the session was signed out or lost access |

**Scopes.** A command needs its scope (`read` ⊂ `write` ⊂ `exec` ⊂ `admin`), checked by `hasScope` before `decide()` checks the workspace permission.

---

## Commands

`packages/protocol/src/commands.ts`; decided in `apps/server/src/decide.ts`.

| Command | Scope | Purpose | Notes |
|---|---|---|---|
| `project.create` | write | new project: `workspaceId`, `repoUrl?`, `name?`, `branch?`, `mode?`, `database?` | no `repoUrl` = start an empty repository |
| `project.start` / `project.stop` | exec | container lifecycle | no container runtime exists; see [spec Open work](./spec.md#open-work) |
| `project.delete` | admin | delete project, files and log | |
| `thread.create` | write | new session: base branch, title, credential source, `worktreeOf?` | |
| `thread.send` | exec | send a message: `text`, `provider?`, `model?`, `effort?`, `mode?` (`research`/`documentation`), attachments | claims the thread |
| `thread.cancel` | exec | stop the turn | |
| `thread.permission_reply` | exec | answer a tool permission request (`allow`/`deny`, `allowAll?`) | |
| `thread.revert` | write | restore a turn's checkpoint | always refused today: nothing captures checkpoints |
| `thread.fork` | write | new thread from a turn | creates an empty "Fork" thread |
| `thread.compact` | exec | fold older turns (`focus?`) | OMP threads |
| `thread.handoff` | exec | replace context with a brief (`focus?`) | OMP threads |
| `thread.handoff_to` | exec | continue on another provider (`targetProvider`, `focus?`, `message?`, `reason?`) | |
| `terminal.create` / `terminal.close` | exec | open or close a PTY | |
| `terminal.input` / `terminal.resize` | exec | as commands; the frames above are the fast path | |
| `file.write` | write | write a file | refuses without a running container; the REST file routes are used |
| `git.commit` / `git.push` | write / admin | | same; the REST git routes are used |
| `preview.publish` / `preview.delete` | write | published commit previews | not built |
| `review.run` | exec | OMP code review of `uncommitted`, `branch` or `commit` | |

---

## Events

`packages/protocol/src/events.ts`. Durable events are appended to `events` and projected; transient ones (marked †) are only published.

| Group | Events |
|---|---|
| Project | `project.created`, `project.cloned`, `project.stack_detected`, `container.state_changed`, `project.activity`† |
| Thread lifecycle | `thread.created`, `thread.worktree_ready`, `thread.worktree_failed`, `thread.removed`, `thread.cancel_requested` |
| Messages and context | `user.message`, `context.injected`, `context.usage` |
| Scheduling | `agent.queued`, `turn.dequeued`, `turn.started` |
| Streaming | `agent.thinking_delta`†, `agent.text_delta`† (coalesced) |
| Agent | `agent.session_started` (resume token), `agent.retry`, `agent.tool_use`, `agent.tool_result`, `agent.permission_requested`, `agent.permission_resolved`, `agent.message`, `agent.turn_completed`, `agent.turn_failed` (`limit?`) |
| Subagents | `agent.subagent_started`, `agent.subagent_progress`, `agent.subagent_finished` |
| Compaction and handoff | `thread.compaction_requested`, `thread.compaction_finished`, `thread.handoff_requested`, `thread.handed_off`, `thread.handoff_failed` |
| Checkpoints | `checkpoint.captured`, `checkpoint.reverted` (defined, not produced) |
| Files and data | `file.changed` (`worktreeId`, origin), `note.changed`, `timeline.changed`, `task.changed`, `upload.changed`†, `resource.changed`† (`LiveResource`: what to refetch) |
| Collaboration | `composer.changed`†, `presence.changed`†, `audit.recorded` |
| Ports and terminals | `port.opened`†, `port.closed`†, `terminal.output`† |
| Git and previews | `git.committed`, `git.pushed`, `preview.published` |
| Reviews | `review.requested`, `review.completed`, `review.failed` |

---

## Server modules

`apps/server/src/`. Main exports per module (classes in **bold**).

| Module | Exports | Role |
|---|---|---|
| `index.ts` | (entry) | boot: config, DB, migrations, services, routes, `/ws`, reactors, shutdown |
| `collab.ts` | (entry) | the collab service process |
| `config.ts` | `loadConfig`, `logLevel`, `webOrigin`, `shellPluginEnabled`, `cliProvidersEnabled` | validated configuration |
| `decide.ts` | `decide` | the pure decision function |
| `engine.ts` | **`OrchestrationEngine`**, **`ProjectionConflict`**, `applyProjection` | command processing and projections |
| `eventstore.ts` | **`EventStore`** | append with stream lock, history, bounded cache |
| `bus.ts` | **`EventBus`**, `topicKey` | in-process pub/sub |
| `worker.ts` | **`DrainableWorker`**, **`KeyedWorker`** | observable queues, per-key lanes |
| `ws.ts` | **`WebSocketGateway`**, `terminalFrame` | the `/ws` gateway |
| `delta-coalescer.ts` | **`DeltaCoalescer`**, `isDelta` | token batching |
| `auth.ts` | **`AuthService`** | sessions, tickets, GitHub OAuth, default user |
| `password.ts` | `hashPassword`, `verifyPassword` | scrypt |
| `crypto.ts` | `encryptSecret`, `decryptSecret` | AES-256-GCM |
| `github-admission.ts` | `admitGithubUser` | who GitHub sign-in admits |
| `http-guards.ts` | `originAllowed` | API-wide request checks |
| `access.ts` | **`ProjectAccess`** | may a user open a project |
| `workspaces.ts` | **`WorkspaceService`**, `toMembership`, `toPolicy`, `publicSlugFor`, `slugify` | workspaces, projects lists, slugs |
| `workspace-members.ts` | **`WorkspaceMemberService`**, `hashInviteToken` | members, invites |
| `workspace-members-routes.ts` | `registerWorkspaceMemberRoutes` | member, invite, settings, credential routes |
| `agent.ts` | **`AgentTurnReactor`**, `resolveProvider`, `resolveModel`, `turnKindOf`, `shouldRecheckStack`, `withResearchUsage`, `claudePromptNeedsPerson`, `ompInstructions` | running turns |
| `turn-scheduler.ts` | **`TurnScheduler`** | turn admission and queue |
| `providers.ts` | **`ProviderService`**, `workspaceSubject`, `workspaceOfSubject` | credential dirs, environments, probes |
| `quotas.ts` | `fetchClaudeUsage`, `fetchCodexUsage`, `openRouterWindows`, parsers | usage meters |
| `openrouter.ts` | `streamCompletion`, `listModels`, `cachedCatalogue`, `contextLengthFor`, `supportsImages`, `keyQuota`, `setOpenRouterBase` | OpenRouter client |
| `research.ts` | `researchBackends`, `researchAsk`, `briefedPrompt` | research backends and CLI briefs |
| `documents.ts` | `documentsBackends`, `documentationPrompt` | doc kit backends |
| `omp-overlay.ts` | `ompOverlay`, `writeOmpOverlay`, `ompApprovals`, `overlayKeyPaths`, `toYaml`, `ompContextThreshold` | per-turn OMP config |
| `omp-handoff.ts` | `renderTranscript`, `buildHandoffBrief`, `handoffPrompt`, `handoffMessage`, `handoffTitle`, `maskSecrets` | handoff briefs |
| `omp-memory.ts`, `omp-memory-routes.ts` | `memoryStats`, `clearMemory`, `retainStdin`, `registerOmpMemoryRoutes` | mnemopi banks |
| `omp-review.ts`, `review-routes.ts` | `runReview`, `reviewChanges`, `reviewPrompt`, `parseReview`, `splitDiff`, `registerReviewRoutes` | code review |
| `omp-bridge-config.ts` | `bridgeServer`, `writeClaudeMcpConfig`, `writeCodexBridge` | bridge wiring for CLI turns |
| `bridge-leases.ts` | **`BridgeLeases`** | OMP slots for bridge calls over a Unix socket |
| `terminal-bridge.ts` | **`TerminalBridge`**, `terminalBridgeFacts` | bridge for CLIs run in terminals |
| `terminals.ts` | **`TerminalReactor`**, `loginShell`, `shellArgv`, `terminalEnv`, `isSecretName` | PTYs |
| `child-priority.ts` | `prefixFor`, `wrapperFor`, `terminalPriority`, `probePriorityTools`, `which` | OOM score and nice |
| `files.ts` | **`WorkspaceFiles`**, `PathError`, `ConflictError`, `StaleWriteError`, `contentVersion`, `isSecretPath`, `withoutSecrets` | confined file access |
| `file-watcher.ts` | **`FileWatcher`**, `isGitStatePath` | disk changes → `file.changed` |
| `trees.ts` | `treeFor`, `projectRoot`, `sessionTree`, `sessionTreesOf`, `worktreeIdOf`, `treeHashOf`, `projectOf` | where files are |
| `worktrees.ts` | **`WorktreeReactor`** | session worktrees |
| `session-lifecycle.ts` | **`SessionLifecycle`**, `SessionBusyError`, `SessionUnsavedError` | removing sessions |
| `uploads.ts` | **`UploadStore`**, `safeName`, `contentDisposition` | attachment staging |
| `search.ts` | `searchWorkspace`, `searchArgv`, `searchTerms`, `parseMatches`, `SearchError` | ripgrep |
| `replace.ts` | `applyReplacements`, `compilePattern` | replace ticked matches |
| `git.ts` | **`GitService`**, `GitRefError`, `parseStatusV2`, `parseLog`, `parseForEachRef`, `parseNameStatusZ` | git operations |
| `git-exec.ts` | `runGit`, `gitSubcommand`, `safeRepoUrl`, `GitError`, `RepoUrlError` | running git safely |
| `git-cache.ts` | **`GitCache`** | shared git reads |
| `git-routes.ts` | `registerGitRoutes` | `/git/*` routes |
| `clone.ts` | **`CloneReactor`**, `detectStack`, `listRemoteBranches`, `parseRemoteRefs`, `ensureWorkspaceRoot` | cloning, stack detection |
| `github.ts` | `listRepos`, `listBranches`, `identify`, `tokenAppliesTo`, `redactToken`, `GithubError` | GitHub API |
| `preview.ts` | **`PreviewGateway`**, `safeNext`, `staticMediaType` | preview proxy |
| `port-watcher.ts` | **`PortWatcher`** | dev-server up/down |
| `web-proxy.ts` | **`WebProxy`**, `classifyRequest`, `isApiPath` | single-port edge |
| `collab-link.ts` | **`CollabLink`** | API side of collab |
| `collab/server.ts` | `createCollab` | Hocuspocus setup, auth, load/store |
| `collab/documents.ts` | `parseDocumentName`, `noteDocumentName`, `fileDocumentName` | `note:{id}` / file document names |
| `collab/prosemirror-y.ts` | `writeDocToFragment`, `readDocFromFragment` | ProseMirror ↔ Yjs |
| `collab/file-merge.ts` | `rebase` | disk change into an open document |
| `collab/note-documents.ts`, `collab/secret.ts` | `noteDocuments`, `collabSecret` | storage, shared secret |
| `composer.ts` | **`ComposerStore`** | shared prompt box |
| `presence.ts` | **`PresenceStore`** | who is where |
| `notes.ts`, `notes-routes.ts` | **`NotesService`**, `isDescendant`, `renumber`, `registerNoteRoutes` | documentation pages |
| `diagrams.ts` | `isDiagramKind`, `diagramAsk`, `extractMermaid` | diagram generation |
| `mermaid-repair.ts` | `repairMermaid`, `quoteLabel` | make Mermaid parse |
| `tasks.ts`, `tasks-routes.ts` | **`TasksService`**, `toTask`, `registerTaskRoutes` | Tasks board |
| `task-pipeline.ts` | **`TaskPipeline`**, `researchPrompt`, `codingPrompt`, `verifyBrief`, `verifyPrompt`, `parseVerdict`, `ompVerdict` | carrying cards |
| `task-scheduler.ts` | **`TaskScheduler`**, `isDue`, `localClock`, `usageBlock` | Auto Run |
| `timeline.ts`, `timeline-routes.ts` | **`TimelineService`**, `wouldCycle`, `registerTimelineRoutes` | Gantt |
| `field-guard.ts` | `staleFields` | per-field conflicts |
| `env-vars.ts`, `env-vault.ts`, `env-routes.ts` | **`EnvVarService`**, `readVault`, `registerEnvRoutes` | environment variables and the project key |
| `public-routes.ts` | `registerPublicRoutes`, `publicUrl`, `rewriteUploadUrls` | public sites |
| `database-connections.ts`, `database-routes.ts`, `database-probe.ts` | **`DatabaseConnectionService`**, `registerDatabaseRoutes`, `probe` | saved servers |
| `db-manager/*` | `adapterFor`, **`MysqlAdapter`**, **`PostgresAdapter`**, `withMysql`, `withPostgres`, `splitStatements`, `quoteIdent`, `quoteLiteral`, `columnDdl`, `parseCsv`, `serializeCell`, errors (`DbConnectError`, `DbQueryError`, `RowConflictError`, `DbRefusal`) | database manager |
| `db-manager-routes.ts` | `registerDbManagerRoutes` | manager routes |
| `dev-database.ts` | `ensureDevDatabase`, `databaseUrl`, `writeDatabaseUrl`, `ensureProjectInfo`, `readProjectKnowledge`, `renderContext` | dev DBs, `.ucch` knowledge |
| `storage.ts` | **`StorageService`**, `directoryBytes` | disk usage |
| `project-stats.ts` | `recomputeProjectStats`, `turnFailed` | stats projection |
| `project-activity.ts` | **`ProjectActivityPublisher`**, `activityOf` | sidebar agent state |
| `audit.ts`, `route-audit.ts` | **`AuditLog`**, `describeRoute`, `mergeDetails`, `textDelta` | activity log |
| `metrics.ts` | **`Registry`**, `Counter`, `Gauge`, `Histogram`, `startRuntimeMetrics`, `routeTemplate`, `recordVitals`, `metricsAccess` | `/metrics` |
| `resource-sampler.ts` | **`ResourceSampler`**, `classify`, `aggregate`, `/proc` parsers | memory/CPU by group |
| `watchdog.ts` | **`Watchdog`**, `serverReadings`, `windowQuantileMs` | alerts |

---

## Packages

### `@ucch/protocol` (`packages/protocol/src`)

| Module | Exports |
|---|---|
| `commands.ts`, `events.ts`, `rpc.ts` | `Command`, `DomainEvent`, client/server frames, `REQUIRED_SCOPE`, `hasScope`, `ProviderId`, `ProjectMode`, `ContainerState`, `stoppedShort`, `isTransient` |
| `hostname.ts` | `parseHost`, `projectUrl`, `previewUrl`, `parsePathAlias`, `parsePreviewAlias` |
| `ids.ts` | `generateHash`, `sessionBranch` |
| `paths.ts` | `normalizeWorkspacePath` |
| `permissions.ts` | `needsApproval`, `isRiskyCommand`, `AgentPermissionMode` |
| `workspace-roles.ts`, `plain.ts` | roles, `ROLE_PERMISSIONS`, `can`, `permissionsOf`, `canManageMember`, `canAssignRole`, `resolveCredentialSource`, `effectiveCredentialSource`, `PROJECT_MODES`, `suggestDevDatabaseName`, `privilegesFor` (`plain.ts` is the zod-free browser entry, `@ucch/protocol/plain`) |
| `agent-settings.ts` | `WorkspaceAgentSettings`, `readAgentSettings`, `limitFallback` |
| `database.ts`, `git.ts`, `tasks.ts`, `timeline.ts`, `notes.ts`, `keys.ts`, `verifier.ts` | request/response shapes for those features; `verificationText` |
| `media.ts` | `previewKindFor`, `mediaTypeFor`, `isPreviewable`, `isModelImageType`, `extensionOf` |
| `avatar.ts` | `isAvatarDataUrl`, `decodedLength` |
| `note-text.ts` | `noteText`, `snippetAround` |
| `text-replacement.ts` | `replacement` |
| `tokens.ts` | `estimateTokens` (4 chars/token) |

### `@ucch/db` (`packages/db/src`)

`createDatabase(url, { max })`, `DEFAULT_POOL_MAX`, `runMigrations(url)` (`bootstrap.ts`), and the schema tables listed in [architecture §6](./architecture.md#6-data-model). `pnpm db:generate` creates a migration from the schema; `pnpm db:migrate` applies them (the server also applies them on boot).

### `@ucch/agent` (`packages/agent/src`)

| Module | Exports |
|---|---|
| `loop.ts` | `runTurn`: one native turn (stream, tools, approvals, iterations cap) |
| `context.ts` | `measure`, `usableTokens`, `pruneToolResults`, `compact`, `summaryMessage`, `PRUNE_RATIO`, `COMPACT_RATIO`, `KEEP_RECENT_RESULTS` |
| `prompt.ts` | `buildPrompt`, `renderKnowledge`, `invalidateTree`, `MAX_INSTRUCTIONS_BYTES`, `MAX_KNOWLEDGE_ENTRIES` |
| `registry.ts` | `ALL`, `selectPreset`, `toolsFor`, `schemasFor`, `toolByName`, `buildSchemas`, `hostToolsFor`, `hostToolSchemas` |
| `tool.ts`, `run-tool.ts` | `defineTool`, `executionModeOf`, `runTool` (shared by native and OMP host tools) |
| `arguments.ts` | `parseToolArguments` (repairs model argument types) |
| `executor.ts`, `executors/host.ts`, `executors/confine.ts` | `HostExecutor`, `HeavyJobGate`, `ExecInterruptedError`, `assertRealpathInside`, `isGitInternalPath` |
| `session-log.ts` | `rebuild`, `INTERRUPTED` |
| `web.ts`, `research.ts`, `documents.ts` | `openrouterPluginProvider`, `bindResearch`, `sonarSearchProvider`, `crawl4aiReader`, `browserUseAgent`, `looksGated`, `bindDocuments`, `DOCUMENT_TYPES`, `DOCUMENTATION_RULES`, `DOCUMENTATION_SKILLS` |
| `schema.ts` | `toJsonSchema` |
| `doc-kit/` | `scripts/` (Python), `templates/base.typ`, `skills/`, `fonts/` |

### `@ucch/providers` (`packages/providers/src`)

| Module | Exports |
|---|---|
| `types.ts` | provider interface, `FORBIDDEN_ENV`, `forbiddenEnvPresent`, `ALLOWED_CREDENTIAL_ENV`, `forbiddenEnvFor` |
| `registry.ts` | `createProviders`, `PROVIDER_LABELS` (`native` "Custom (legacy)", `claude`, `codex`, `omp` "Custom"), `isCliProviderId` |
| `process.ts`, `run.ts` | `HostProcessHost`, `splitLines`, `EXIT_SIGTERM`, `runCli`, `exitedBySignal` |
| `claude.ts` | `ClaudeProvider`, `claudeArgv`, `ClaudeNormaliser`, `probeClaude`, `isClaudeLimit`, `explainClaudeError`, `mapUsage`, `CLAUDE_MODELS`, `ompBridgeToolName` |
| `codex.ts` | `CodexProvider`, `codexArgv`, `codexMcpArgs`, `codexPrompt`, `CodexNormaliser`, `probeCodex`, `isCodexLimit`, `mapCodexUsage`, `CODEX_MODELS`, `CODEX_SUBSCRIPTION_WARNING` |
| `omp.ts` | `OmpProvider`, `ompArgv`, `ompPrintArgv`, `ompCallArgv`, `OmpNormaliser`, `probeOmp`, `ompModel`, `approvalFor`, `thinkingFor`, `contextReading`, `describeCompaction`, `editOperations`, `ompStructuredResults` |
| `omp-rpc.ts`, `omp-rpc-types.ts` | `OmpRpc` (JSONL RPC client, protocol v2 chunking) |
| `omp-credentials.ts`, `omp-tools.ts`, `omp-roles.ts`, `omp-assets.ts` | `OMP_CREDENTIAL_ENV`, `isOmpCredentialEnv`, `OMP_TOOL_TIERS`, `OMP_FOREIGN_SOURCES`, `ompVerifierPrompt`, `parseVerifierReply`, `ompGuardHookSource`, `ompBridgeGuide` |
| `testing.ts` | scripted `ProcessHost` for tests; recorded fixtures in `fixtures/` |
| `assets/omp-hooks/ucch-guard.ts` | the OMP guard hook |

### `@ucch/omp-bridge` (`packages/omp-bridge/src`)

| Module | Exports |
|---|---|
| `index.ts` | stdio entry (built to `dist/omp-bridge.mjs`) |
| `server.ts` | `createBridgeServer` |
| `config.ts` | `readBridgeConfig`, `ompEnv`, `refuseForeignCredentials`, `withEnvFile` |
| `call.ts` | `runOmpCall`, `callArgv`, `costLine`, `RESULT_BYTES` (64 KB) |
| `guard.ts` | `guardOverlay`, `writeGuard`, `SUBAGENT_READS` |
| `lease.ts` | `callGate`, `BUSY` |
| `tools/*` | `BRIDGE_TOOLS`: `ompTask`, `ompReview`, `ompSymbols`, `ompRename`, `ompCodemod`, `ompDebug`, `ompRecall`, `ompRetain`, `ompHandoffBrief` |

Bridge environment variables: `OPENROUTER_API_KEY`, `UCCH_OMP_OVERLAY`, `UCCH_OMP_BIN`, `UCCH_OMP_AGENT_DIR`, `UCCH_WORKTREE`, `UCCH_OMP_TRUSTED`, `UCCH_OMP_MEMORY`, `UCCH_OMP_WEB_SEARCH`, `UCCH_BRIDGE_MAX_SECONDS` (300), `UCCH_BRIDGE_MAX_CALLS` (12), `UCCH_SCHEDULER_SOCK`, `UCCH_BRIDGE_ENV_FILE`.

**Bridge tools**

| Tool | Input | `--tools` |
|---|---|---|
| `omp_task` | `agent` (`scout`, `reviewer`, `security-reviewer`, `sonic`), `assignment`, `files?` | `read,grep,glob,lsp,task` (+`edit,write` for sonic) |
| `omp_review` | `scope` (`uncommitted`, `branch`, `commit`), `ref?`, `focus?` | `read,grep,glob,task` |
| `omp_symbols` | `op` (`definition`, `references`, `implementations`, `type`, `diagnostics`), `symbol?`, `file?`, `line?` | `lsp,read` (trusted only) |
| `omp_rename` | `symbol`, `file`, `line?`, `newName`, `apply` | `lsp,read` (+`edit,write`) |
| `omp_codemod` | `description`, `pattern?`, `rewrite?`, `language?`, `paths?`, `apply` | `ast_edit,read` (+`write`) |
| `omp_debug` | `goal`, `program?`, `args?`, `attachPid?`, `breakpoints?` | `debug,read,bash,grep`, on `@default` (trusted only) |
| `omp_recall` / `omp_retain` | `query` / `fact`, `kind?` | `recall` / `retain` (memory on) |
| `omp_handoff_brief` | `transcript`, `focus?` | none |

---

## Web app

`apps/web/src/lib` (client modules; tests sit beside them):

| Area | Modules |
|---|---|
| API clients | `account-api`, `activity-api`, `database-api`, `diagrams-api`, `files-api`, `git-api`, `github-api`, `keys-api`, `notes-api`, `omp-trust-api`, `preview-api`, `providers-api`, `public-api`, `review-api`, `search-api`, `tasks-api`, `timeline-api`, `uploads-api`, `workspace-api`, `session` (server-side reads) |
| Realtime and data | `realtime.tsx` (socket, subscriptions), `realtime-cache.ts` (event → query invalidation), `thread-store.ts`, `query-client.tsx`, `query-keys.ts`, `queries/`, `use-invalidate.ts`, `composer-sync.ts`, `collab.ts`, `note-collab.ts`, `doc-sync.ts`, `tab-id.ts` |
| Navigation and loading | `view-transitions.tsx` (`TransitionLink`, `useTransitionRouter`), `sections.ts` (routes, rail, settings pages, doc views, diagram kinds), `warmup.ts`, `preload.ts`, `last-location.ts`, `workspace-route.ts`, `workspace-cookie.ts`, `auth-gate.ts` |
| Chat | `chat-messages.ts`, `streaming-markdown.ts`, `slash-commands.ts`, `slash-filter.ts`, `file-mention.ts`, `prompt-history.ts`, `attachments.ts`, `file-drop.ts`, `context-window.ts`, `turn-status.ts`, `agent-activity.ts`, `chat-feedback.ts`, `thread-position.ts`, `model-preference.ts`, `composer-size.ts`, `code-chat.ts` |
| Editor | `vim-keymap.ts`, `leader-keymap.ts`, `editor-keybindings.ts`, `editor-font-size.ts`, `editor-selection.ts`, `line-moves.ts`, `line-search.ts`, `syntax-highlight.ts`, `syntax-theme.ts`, `languages.ts`, `highlight-lines.ts`, `code-text.ts`, `mermaid-language.ts` |
| Files | `file-tree.ts`, `file-icons.ts`, `file-icons-server.ts`, `icon-resolver.ts`, `tree-font-size.ts`, `stack-icons.ts` |
| Notes | `note-tree.ts`, `note-search.ts`, `note-autosave.ts`, `note-drop.ts`, `markdown-paste.ts`, `markdown-file.ts`, `markdown-containers.ts`, `embed-url.ts`, `emoji-search.ts`, `drawio-protocol.ts`, `doc-width.ts` |
| Git | `git-diff.ts`, `review-anchor.ts`, `repo-url.ts` |
| Boards | `gantt.ts`, `field-edit.ts` |
| Database | `db-cells.ts`, `database-url.ts` |
| Theme | `theme.ts`, `theme-css.ts`, `color-engine.ts`, `selection-color.ts`, `person-color.ts` |
| PWA and ops | `pwa.ts`, `pwa-caches.ts`, `app-update.ts`, `vitals.ts`, `next-frame.ts` |
| Misc | `quotas.ts`, `usage-breakdown.ts`, `stats-format.ts`, `uptime.ts`, `image-resize.ts`, `avatar-image.ts`, `zoom.ts`, `clipboard.ts`, `confirm-name.ts`, `credential-choice.ts`, `create-project.ts`, `project-target.ts`, `project-sessions.ts`, `public-url.ts`, `public-project.ts`, `manage-tabs.ts`, `sidebar-metrics.ts`, `use-new-session.ts`, `workspace-context.tsx`, `workspace-header.ts`, `utils.ts` |

Components (`apps/web/src/components`) by feature: shell (`app-shell`, `app-sidebar`, `app-header`, `section-panel`, `rail-flyout`, `right-sidebar`, `quick-menu*`, `workspace-switcher`), chat (`project-chat`, `chat-dock`, `markdown`, `permission-prompt`, `subagent-card`, `turn-progress`, `context-meter`, `model-picker`, `provider-picker`, `composer-menu`, `attachment-preview`), files (`files-panel`, `files-tree`, `code-editor`, `vim-editor`, `file-preview`, `image-viewer`, `pdf-viewer`, `search-panel`), `terminal-view` / `xterm-pane`, `git/*`, `notes/*`, `diagrams/*`, `tasks/*`, `timeline/*`, `database/*`, `keys/*`, `public/*`, `activity/*`, settings (`*-settings.tsx`, `settings-page`, `workspace-settings-page`), `page-skeletons`, `on-demand`, `ui/*` (shadcn primitives).

---

## Agent tools

Native loop tools (`packages/agent/src/tools`), by preset (`registry.ts`):

| Tool | Preset | Does |
|---|---|---|
| `read_file` | coding | read lines of a file (numbered, bounded) |
| `write_file` | coding | create or replace a file |
| `edit_file` | coding | exact string replacement |
| `delete_file` | coding | delete a file |
| `list_dir` | coding | list a directory |
| `glob` | coding | find paths by pattern |
| `grep` | coding | ripgrep, `path:line: text` |
| `bash` | coding | shell command in the workspace (when `shellPluginEnabled`) |
| `web_search` | coding | search through the configured provider |
| `web_fetch` | coding | fetch a URL as text (unsafe addresses refused) |
| `attach_upload` | coding | move a staged attachment into the tree |
| `current_time`, `ping` | coding | the time; ping a hostname or IPv4 |
| `research_search`, `research_read`, `research_browse` | research | Sonar search, Crawl4AI read, Browser Use browse |
| `doc_read`, `doc_inspect`, `doc_edit`, `doc_render`, `doc_diagram`, `doc_chart`, `doc_check`, `doc_skill` | documentation | the document pipeline |

---

## Scripts and commands

**Root `package.json`**

| Command | Does |
|---|---|
| `pnpm dev:up` | full local setup and run (`scripts/dev.sh`) |
| `pnpm dev:down` | stop the dev databases |
| `pnpm dev` | run every package's `dev` / `dev:collab` in parallel |
| `pnpm build` | build every package |
| `pnpm typecheck` | typecheck every package |
| `pnpm test` / `pnpm test:watch` | vitest from the root |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations |

**Packages**: `@ucch/server`: `dev`, `dev:collab`, `start`, `build` (`build.mjs`, esbuild bundles `dist/server.mjs` and `dist/collab.mjs`), `start:dist`, `start:collab`. `@ucch/web`: `dev`, `build`, `start`, `typecheck`, `e2e` (Playwright specs in `apps/web/e2e`). `@ucch/omp-bridge`: `build`.

**Running one test file:** `pnpm vitest run apps/server/src/replace.test.ts`. `pnpm test -- X` runs everything.

**`scripts/`**

| Script | Does |
|---|---|
| `dev.sh` | creates `.env`, installs, starts the dev databases, runs the apps |
| `smoke-container.sh` | end-to-end checks against the built single-container image |
| `pg-top.sh` | top statements from `pg_stat_statements` (`--reset` to zero) |
| `load/up.sh` | start the production image and a Postgres for load tests |
| `load/run.mjs` | the load generator (simulated users by role) |
| `load/profile.sh <label>` | the full measurement profile; raw output to `documentation/perf/<label>/` |
| `load/summarise.mjs <dir>` | fold a profile run into the headline figures |
| `load/fake-claude.mjs`, `load/fake-omp*.{mjs,sh}`, `load/mock-openrouter.mjs` | stand-ins for the CLIs and OpenRouter |
| `omp/record-rpc.mjs` | record OMP RPC fixtures (`--check` re-parses them) |
| `omp/probe-safety.mjs` | plant project-scope OMP config and report what loads |
| `omp/measure-rss.mjs` | OMP startup time and memory |
| `omp/scripted-model.mjs` | a scripted OpenAI-compatible model for the above |

**In the container**: `ucch-backup` (dump and `secret_key` to `/data/backups/<ts>`, keep `BACKUP_KEEP`), `ucch-restore <dir|dump>`.

**`apps/web/scripts/bundle-budget.mjs --check`**: fails when a route's first-load JS exceeds its budget (run in CI).
