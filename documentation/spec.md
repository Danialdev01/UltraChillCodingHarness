# UCCH specification

Every feature UCCH has today, what it does, how a person uses it, and how it works from the click to the database. The last section, [Open work](#open-work), lists what is defined but not working, and what is planned.

Related: [`architecture.md`](./architecture.md) (stack and structure), [`solutions.md`](./solutions.md) (why things are built the way they are), [`reference.md`](./reference.md) (routes, frames, commands, events, modules).

Notation: **UI** is where a person finds it; **Flow** is the path through the system; **Rules** are limits and refusals.

---

## 1. Accounts and sign-in

**Ways in** (at least one must be configured, or the server won't start):
- **Email and password.** A default account is seeded on first boot from `DEFAULT_USER_EMAIL` / `DEFAULT_USER_PASSWORD`, and only when that email is unused, so restarts never reset it. In the image, a missing password is generated into `/data/secrets/default_user_password`.
- **GitHub OAuth** (`GITHUB_CLIENT_ID`/`SECRET`). Admission follows `GITHUB_ALLOWED_USERS` / `GITHUB_ALLOWED_ORGS`; with neither set, only existing accounts may sign in. The OAuth token is kept, encrypted, and doubles as the account's GitHub token for listing repositories.
- **`DEV_AUTH_BYPASS=true`** (development only): every request is a fixed local user.

**Flow.** `POST /api/auth/login` checks the scrypt hash and creates a `sessions` row with a cookie (20 tries a minute per address). `/api/auth/github` → GitHub → `/api/auth/github/callback` creates or matches the user. `POST /api/auth/logout` deletes the session, and every socket on it gets `revoked`. The middleware (`apps/web/src/middleware.ts`) sends signed-out visitors to `/login`, and after sign-in they return to the page they asked for, else the last one they were on.

**Account page** (`/setting/account`): display name, email, password (needs the current one), avatar (an image shrunk in the browser to a `data:` URL, size-capped). Each is its own form with its own save (`PUT /api/account/{name,email,password,avatar}`).

---

## 2. Workspaces

A workspace holds projects and members. Every account gets a "Personal" workspace on first sign-in.

**UI.** The switcher at the top of the sidebar (searchable), "New workspace", and "Manage workspace" (name, logo, kind, archive, delete when empty). The workspace's address is `/{workspaceHash}`, which opens its dashboard.

**Kinds.** `project` (named codebases) or `session` (each project row is a lightweight chat with its own files and terminal, listed as session cards and opened at `/{ws}/s/{hash}`). Only the UI treats the two differently.

**Dashboard** (`/{ws}`): four figures (from the `project_stats` projection and `/api/workspaces/:id/stats`) and the project list. **Code** (`/{ws}/code`): every project as a sortable table.

**Members and roles** (`/{ws}/workspace-settings/members`):

| Role | May |
|---|---|
| owner | everything; can't be removed or demoted |
| admin | everything except deleting the workspace or managing the owner or other admins |
| member | view, create projects, edit, start sessions |
| viewer | view only (read-only in co-edited documents too) |

Per member, an owner or admin can allow or refuse **creating projects** and **starting sessions** regardless of role. Members are added by email or GitHub login (`POST /api/workspaces/:id/members`) or by **invite link** (`/workspace-settings/sharing`). A link carries a role and an expiry, is shown once (only its hash is stored), can be revoked, and is accepted with a click at `/invite/{token}`.

**Harness subscription** (`/workspace-settings/harness`, `credentials.manage` to change):
- `credential_policy`: `member` (each person's own subscriptions and keys pay), `workspace` (the workspace's dedicated OpenRouter key, Claude token or login, and Codex login pay), or `either` (the person starting a thread chooses, defaulting to their own). A fixed policy also applies to existing threads.
- **Agent settings** (`agent_settings`):
  - automatic handoff on a usage limit (with a fallback provider);
  - isolated fan-out for OMP workers;
  - the OMP bridge for Claude Code and Codex;
  - OMP memory (`llmMode` `smol`/`none`, and retaining CLI turns);
  - verifying tasks with OMP.

  See §8 and §12.

**Usage** (`/{ws}/workspace-settings/usage`, `/api/workspaces/:id/usage`): tokens and cost by person, project and model, from the `turns` table. **Storage** (`/api/workspaces/:id/storage`): bytes per project directory.

---

## 3. Projects

**Create** ("New project", quick actions or the palette). There are three sources:
- **GitHub**: pick from the repositories the account's token can see (`/api/github/repos`) and a branch (`/api/github/repos/:owner/:repo/branches`).
- **Custom URL**: any git URL, with an optional branch.
- **New**: an empty repository, named for you.

A **mode** (`research`, `development`, `creative_design`) is chosen too. A `development` project can also get a **dev database**: an engine and a name, created on the embedded Postgres or MariaDB as the `dev` user.

**Flow.** The dialog dispatches `project.create` over `/ws`, and `decide()` checks `project.create` permission. Then:
1. `project.created` is appended and the `projects` row projected.
2. The clone reactor (`clone.ts`) clones into `WORKSPACE_ROOT/{projectId}` with progress, then records `project.cloned`.
3. `detectStack` reads the root files (Laravel, Next.js, Nuxt, Astro, Svelte, Angular, React, Vue, Vite, Deno, Bun, Node, Django, Python, Rust, Go, Rails/Ruby, Kotlin, Java, Dart, Elixir, Swift, …) and records `project.stack_detected`. The stack icon appears in the sidebar.

The stack is re-checked every 5 turns.

**Manage** (`/{ws}/p/{project}/manage`): four figures (two of them, uptime and context, are placeholders and labelled as such), then tabs:
- **Git**: remote settings.
- **Activity**.
- **Preferences**:
  - preview port or folder;
  - public site on/off;
  - "Trusted repository" for OMP;
  - Tasks-board agent and schedule;
  - documentation page width.

**Rename** with `PATCH /api/projects/:hash`. **Delete** with `DELETE /api/projects/:hash`: type the project's name to confirm. It removes the files and the entire event log, with no undo.

**Keys** (`/{ws}/p/{project}/keys`): named secrets for the project (API keys, tokens), encrypted at rest. The list never carries values. A value is fetched on demand (`GET …/keys/:keyId/value`) and hides itself again after a while.

---

## 4. Sessions and chat

A **session** is a conversation (a `thread`) with an agent, at `/{ws}/p/{project}/{sessionHash}`. Several can run at once.

**Starting.** A project's first session works in the project's own checkout. "New session" (the + on the project's sidebar row) picks a **base branch**. The session then gets its own git worktree on branch `ucch/{hash}` under `WORKSPACE_ROOT/.worktrees/{projectId}/{hash}` (`thread.worktree_ready`, or `thread.worktree_failed`), so sessions never touch each other's files.

**Sending a message.**
1. The composer dispatches `thread.send { text, provider?, model?, effort?, mode?, attachments? }`.
2. `decide()` claims the thread (`queued`) and appends `user.message`. A second send while one is in flight is refused.
3. `AgentTurnReactor` asks the `TurnScheduler` for a slot. If none is free, the thread shows `agent.queued` with how many turns are ahead.
4. When admitted, `turn.started` opens a `turns` row and the provider runs (§5). Its stream becomes `agent.text_delta` / `agent.thinking_delta` (coalesced into ~40 ms frames), `agent.tool_use`, `agent.tool_result`, `agent.permission_requested`, `agent.subagent_*`, `context.usage`, `agent.message`.
5. The turn ends with `agent.turn_completed` (with usage, cost and stop reason) or `agent.turn_failed` (with `limit: true` for a usage limit). The thread returns to `idle`.

**What the chat shows:**
- Markdown answers (raw HTML is not rendered).
- Thinking.
- Tool rows, collapsible; subagent calls as one expandable card.
- File-change chips.
- Turn progress: elapsed time and tokens.
- A context meter with "compact".
- The quota rail.
- Usage per turn.

Prompt history is available with ↑/↓, and chat-block navigation with the faded arrows.

**Composer:**
- model picker, effort, and harness (provider) picker;
- **+ menu**: Research and Documentation modes (one at a time), and attach files;
- `@` file mentions;
- slash commands:

| Command | Does |
|---|---|
| `/clear` | start a fresh conversation |
| `/model <id>` | choose the model |
| `/effort <level>` | choose reasoning effort |
| `/harness <provider>` | choose what runs the agent |
| `/research`, `/documentation` | toggle the mode |
| `/attach` | attach files |
| `/compact [focus]` | fold older turns into a summary now |
| `/handoff [focus]` | replace the context with a brief of the work so far |
| `/continue <harness>` | carry the work on in a new thread on another harness (§8) |

**Shared composer and presence.** The draft in a thread's composer is synced to every tab and person viewing it (`composer` frames with a revision; a stale write gets the newer state back). Presence badges show who else has the page open, in their caret colour, pulsing while they type.

**Cancel.** "Stop" dispatches `thread.cancel`. The thread goes to `cancelling`, the run is aborted, and the turn closes with `agent.turn_completed` (or `turn.dequeued` if it never started).

**Attachments.** Files dropped or pasted into the composer are uploaded to staging (`POST /api/projects/:hash/uploads`, max `UPLOAD_MAX_BYTES` = 25 MiB). Staging sits outside the project tree, so they aren't in `git status`. The model sees them as attachments. When asked, it moves one into the project with `attach_upload` (or a person does with "attach"). Unplaced uploads are swept after `UPLOAD_TTL_HOURS` (24). Image, PDF and text previews open in a dialog.

**Removing a session.** `DELETE /api/projects/:hash/sessions/:sessionHash` (with `?ifEmpty=1` the session is kept unless it is empty).
- Removal refuses while the agent is working, and refuses unsaved changes unless they were settled first. Settling pushes the branch when there is a remote.
- A worktree shared through handoff is removed only with its last session.

---

## 5. Agent providers ("harnesses")

| Harness | Requirements | Notes |
|---|---|---|
| **Custom** | an OpenRouter key (Settings → Providers, or the workspace's) | Without `OMP_ENABLED`, the built-in loop (`packages/agent`); with it, new threads run on **OMP**. A thread keeps the runtime it started on. |
| **Claude Code** | `claude` on the server's `PATH`, then a login (a terminal dialog runs the CLI's login with the account's own `CLAUDE_CONFIG_DIR`) or a pasted OAuth token | runs on the Claude subscription; `AGENT_ALLOW_HOST_SHELL` in production |
| **Codex** | `codex` on `PATH`, then a device login | runs on the ChatGPT subscription; the UI shows a terms warning that must be acknowledged |

**Settings → Agent Providers** (`/setting/providers`, `GET /api/providers`):
- each card shows installed, signed in, version and the last probe;
- a CLI can be signed out with `DELETE /api/providers/:id/credentials`;
- the **default provider** and **default model** are set under Workspace Settings → General (`PUT /api/settings/default-provider`, `/default-model`).

The model list comes from OpenRouter's catalogue (`GET /api/models`).

**Permission modes** (Workspace Settings → General; stored on the account, so they follow the person; `PUT /api/settings/agent-permission-mode`):
- `strict`: every call that changes something (an edit or a command) waits for an answer. Reads never wait.
- `normal`: edits and ordinary commands run. Risky commands (`isRiskyCommand`: destroying work, reaching past the project) wait.
- `allow_all`: nothing waits.

A waiting call shows a prompt above the composer: allow, deny, or "allow all for this session". Applies to Custom and Claude Code. Codex runs non-interactively in its own sandbox.

**The built-in loop's tools** (`packages/agent/src/registry.ts`):

| Preset | Tools |
|---|---|
| coding | `read_file`, `write_file`, `edit_file`, `delete_file`, `list_dir`, `glob`, `grep`, `bash` (when allowed), `web_search`, `web_fetch`, `attach_upload`, `current_time`, `ping` |
| research | `research_search`, `research_read`, `research_browse` in place of `web_search` / `web_fetch` |
| documentation | `doc_read`, `doc_inspect`, `doc_edit`, `doc_render`, `doc_diagram`, `doc_chart`, `doc_check`, `doc_skill`; no shell |

There is deliberately no push tool: agents may commit, only people push.

**Project knowledge.** Files under the project's `.ucch/` (and AGENTS.md / CLAUDE.md, up to 16 KB) are given to every agent as context, as `context.injected` events.

**Quota rail.** The sidebar shows a bar each for Claude Code, Codex and OpenRouter: percent used and when it resets, read from the vendors, cached for a minute (`GET /api/account/quotas`, `/api/account/openrouter/quota`).

---

## 6. Research mode

Toggle with **+ → Research** or `/research`. Each message runs a research turn in three escalating steps:
1. **Find**: `research_search` is Perplexity Sonar through OpenRouter (`RESEARCH_SEARCH_MODEL`). It returns an answer, its sources and a line on each.
2. **Read**: `research_read` fetches pages through Crawl4AI (`CRAWL4AI_URL`) as Markdown, several at once.
3. **Browse**: `research_browse` is a Browser Use agent (`BROWSER_USE_API_KEY`). `research_read` escalates to it by itself on a bot check, login wall or 403.

Without a backend, the tool tells the model what's missing. On Claude Code or Codex, research runs first on OpenRouter, using the default model, as a brief. The brief is appended to the message for the CLI, recorded as `context.injected`, and its cost is folded into the turn.

---

## 7. Documentation mode (documents)

Toggle with **+ → Documentation** or `/documentation`. This mode creates, edits and reads PDF, DOCX and DOC files.
- **New documents** are Markdown with `type:` in the front matter (`report`, `spec`, `api-reference`, `proposal`, `runbook`, `memo`). Each type is a preset over one Typst template (`packages/agent/doc-kit/templates/base.typ`), so the model writes content and the template owns the layout.
- **Pipeline**: `doc_render` (Markdown → Pandoc → Typst → PDF, `.docx` or `.html`; ` ```mermaid `, ` ```dot ` and ` ```vega-lite ` fences become figures) → `doc_check` (page budget, fonts, links, overflow, captions, outline) → `doc_inspect` (a vision model, `DOC_VISION_MODEL`, reviews the rendered pages) → patch → re-render. At most two review rounds; three failed renders of one file stop the loop.
- **Editing** keeps a `.docx`'s styles (`doc_edit`). PDFs support forms, pages and metadata.
- Renders run one at a time server-wide (`DOC_JOBS_MAX`).
- On Claude Code or Codex, the message is handed over with the same rules and the kit's script paths, for the CLI to run with its own shell.

---

## 8. Context, compaction, handoff and memory

- **Context meter**: the last completed turn's measured prompt and reply against the model's window.
- **Built-in loop**: the oldest tool results are pruned automatically, then the older half is compacted into a summary (`SEARCH_MODEL`) when the window is still too full.
- **OMP threads**: `/compact [focus]` and `/handoff [focus]` (`thread.compact`, `thread.handoff`) run OMP's own commands on its session (`thread.compaction_requested` → `thread.compaction_finished`).
- **Cross-provider handoff**: `/continue <harness>` (`thread.handoff_to`).
  1. A small model writes a brief from the thread's log: work done, decisions, next steps.
  2. A new thread "Continued: …" opens on the target harness **in the same worktree**, with the brief folded under "Handoff brief".
  3. The two threads link with "Continued in →" / "Continued from ←".
  4. While the brief is written, the composer shows "Writing a brief … for <harness>…". A failure ends with `thread.handoff_failed`.
- **Automatic handoff on a usage limit** (workspace setting): a Claude Code or Codex turn that fails on its plan's limit continues on the fallback provider with the failed message. This happens once per chain.
- **Memory** (workspace setting, OMP): one mnemopi bank per project. OMP turns recall and retain facts. With the bridge on, Claude Code and Codex get `omp_recall` / `omp_retain`. Optionally, each completed CLI turn's final answer is scanned for durable facts. The memory card (Settings) shows counts only and can clear a bank (`GET/DELETE /api/omp-memory/:projectId`).

---

## 9. OMP features

All of these need `OMP_ENABLED`, the pinned `omp` binary (in the image) and an OpenRouter key.
- **Subagents**: OMP's `task` (and Claude Code's `Agent`/`Task`) show as one card per call, with each subagent's progress and result (`agent.subagent_started/progress/finished`, `subagents` table). Up to `OMP_WORKERS_PER_TURN` (4) at once. They work in an isolated copy of the worktree when the workspace turns on isolated fan-out.
- **Code review** (the "Review" button in the Git view; `review.run` command):
  1. `omp-review.ts` reads the diff (uncommitted, branch or commit) and hands it to OMP's bundled `reviewer`.
  2. The verdict (correct or not, why, and findings with priority P0–P3 and confidence) is stored in `reviews` and shown in a banner (`review.requested/completed/failed`).
  3. Findings can be picked and sent to the session's agent as a message.
- **OMP bridge** for Claude Code and Codex (workspace setting): the CLIs get `omp_task` (scout, reviewer, security-reviewer, sonic), `omp_review`, `omp_symbols`, `omp_rename`, `omp_codemod`, `omp_debug`, `omp_recall`, `omp_retain`, `omp_handoff_brief`.
  - Each call is one `omp` process, billed to OpenRouter.
  - Calls are limited by `OMP_BRIDGE_MAX_SECONDS` and `UCCH_BRIDGE_MAX_CALLS`, and take a slot from the server's scheduler.
  - The same bridge is wired into `claude` / `codex` started by hand in a project terminal.
  - It also works in a personal Claude Code outside UCCH; see `README.md`.
- **Trusted repository** (project preference): lets OMP run the repository's own LSP and debugger config. Hooks, MCP, skills and rules stay off regardless.

---

## 10. Files and editor

**UI.** The project view's file tree (right column) and editor, the same in every session (each session sees its own worktree).
- **Tree**: create, rename, move (drag), delete, upload by drop. Material file icons (`/file-icons`). Font size is a preference.
- **Editor**: CodeMirror 6 with syntax highlighting, loaded on first use. Optional **modal keybindings** (vim, with Doom-style emacs chords and a leader-key picker; Workspace Settings → General). Configurable syntax colours, fonts and themes.
- **Previews**: images (pan and zoom: keyboard, wheel, pinch, touch) and PDFs replace the editor. Text, Markdown and Mermaid render where useful.
- **Co-editing**: an open file is a Yjs document on the collab service. Everyone's carets show in their colour. A change on disk (agent, terminal, `git checkout`) is merged into the open document without losing typing (§13).

**Flow.**
- Reads: `GET /api/projects/:hash/files` (tree), `GET …/file?path=` (text), `GET …/file/raw?path=` (bytes under an extension-derived type, sandboxed).
- Writes: `PUT …/file` (save), `POST` (create), `PATCH` (rename or move), `DELETE`.
- `?session=<hash>` selects a session's worktree.
- Every path is confined (no `..`, no symlinks out, no `.git` writes).
- Writes publish `file.changed`. Changes from anything else are picked up by the file watcher.

---

## 11. Search and replace

**UI.** The search sidebar: a query with case-sensitive and regex toggles (a plain query is literal). Results are grouped by file with highlighted matches; clicking one jumps the editor to it. Ticked matches can be replaced.

**Flow.**
- `GET /api/projects/:hash/search?q=…` runs ripgrep in the tree, respecting `.gitignore`, and returns each line with match ranges (capped; the response says when it was cut short).
- **Replace** (`POST …/replace`) sends back only the matches the user left ticked. Each is re-checked against the file as it is now, and replaced only if the pattern still matches at the same place. Otherwise it is reported as stale.

---

## 12. Git and GitHub

**UI.** The Git view (laid out like GitHub Desktop):
- **Toolbar**: the branch picker (switch or create) and one remote button whose label says what it would do: add remote, publish, pull, push, or fetch.
- **Changes**: every changed file with a checkbox that is its staged state. Commit with a summary, a description and a button naming the target branch (⌘/Ctrl+Enter). Discard asks first.
- **History**: commits on the branch with their diffs. A shallow clone offers the rest of the history.
- **Diffs**: unified, with two line-number gutters, highlighted by the editor's grammar.
- **Merge conflicts**: a banner, per-file resolution (take ours, take theirs, or mark resolved after editing), and abort.
- **Review**: an OMP code review of the changes (§9).

**Flow.** REST routes under `/api/projects/:hash/git/*`:
- reads: `status`, `diff`, `log`, `branches`, `commits/:sha`, `commits/:sha/diff`, `remote`;
- writes: `stage`, `unstage`, `discard`, `commit`, `checkout`, `branches`, `fetch`, `pull`, `push`, `remote` (POST/PUT/DELETE), `resolve`, `merge/abort`.

The server caches reads per working tree (`git-cache.ts`) and invalidates them on `file.changed` and git actions. Every git write is announced so all tabs refresh, and is written to the activity log. Pushing and pulling authenticate with the account's GitHub token through a credential helper, and the token never goes on a command line. Commits use the account's name and email.

**Settings → API Management** (`/setting/api`): a GitHub personal token (when not signed in with GitHub), an OpenRouter key and a Resend key, each encrypted (`PUT /api/settings/{github,openrouter,resend}`).

---

## 13. Terminals

**UI.** Terminal tabs in the project view (xterm.js), as many as the caps allow. Full-screen programs, colours and job control all work. Each terminal's working directory is the project (or the session's worktree).

**Flow.**
1. `terminal.create` → the server spawns a PTY (`@lydell/node-pty`) running a login shell as the server user, with a rebuilt environment and child priority (OOM score ≤ 500, nice ≤ 5).
2. Input and resize travel as `terminal_input` / `terminal_resize` frames on the shared socket. They bypass the engine, so keystroke echo stays around 2 ms p95 under load.
3. Output is pushed as `terminal.output` on the `terminal` topic.
4. `terminal.close`, or `TERMINAL_IDLE_MINUTES` (15) without typing, ends it.

**Rules.** At most `TERMINAL_MAX_PER_PROJECT` (10), `_PER_USER` (5) and `_TOTAL` (40) at once. Over a limit the terminal says so, and nothing queues. In production, terminals need `AGENT_ALLOW_HOST_SHELL`.

**CLI logins** for Claude Code and Codex also run in a terminal dialog (`login-terminal-dialog.tsx`), with the account's credential directory.

---

## 14. Live preview

**UI.** The globe button in the project's top bar: enter the dev server's port (or, for plain HTML, a folder to serve). You get:
- **Share address**: `https://<ROOT_DOMAIN>/{hash}/preview` (paths after it are passed on).
- **App origin**: `https://p{port}-{hash}.<ROOT_DOMAIN>`.

The dialog shows "Listening" / "Nothing on port" live.

**Flow.**
1. `PUT /api/projects/:hash/preview` stores the port or folder.
2. `GET /api/projects/:hash/preview/open[/*]` checks membership, mints a single-use ticket and redirects to the preview host.
3. The preview host swaps the ticket for its own cookie.
4. `preview.ts` proxies HTTP and WebSocket upgrades to `127.0.0.1:{port}`, only for that project's stored port.
5. `port-watcher.ts` probes the port while someone has the project open and pushes `port.opened` / `port.closed`.

**Rules.** Any member of the project's workspace may open it. Vite 6+ needs `server.allowedHosts: true`. In production, previews need the wildcard DNS record and certificate. Locally, `*.ucch.localhost:3001` works with `PUBLIC_PREVIEW_PORT=3001`.

---

## 15. Documentation (notes)

**UI.** `/{ws}/p/{project}/documentation`: a page tree (create, nest, drag to move, icons, covers) and a rich editor (Tiptap): headings, lists, tables, callouts, code, links to other pages, images, embeds, Mermaid diagrams, tldraw whiteboards and emoji. Markdown can be pasted. There is search by title and by content (`GET …/notes/search?q=`). The page width is a project preference. The documentation page has four tabs (`?view=`): **Notes**, **Diagrams** (§16), **References** (a placeholder) and **Keys** (§3).

**Flow.**
- `GET/POST /api/projects/:hash/notes`, `GET/PATCH/DELETE …/notes/:noteId`, `POST …/notes/:noteId/move`, `POST …/notes/assets` (images).
- Bodies are ProseMirror JSON, with a plain-text copy for search.
- **Co-editing**: an open page is a Yjs document (`note:{id}`) on the collab service, authorised by a ticket the API redeems. Viewers are read-only. Saves are debounced, stored in `note_ydocs`, and projected to `notes` with a `note.changed` event. Writes from outside an editor (the API or an agent) are applied into the live document.

---

## 16. Diagrams

**UI.** Documentation → Diagrams: one tab per kind: Database, Architecture, System Flow and User Flow (`?diagram=`), with Mermaid source in a code editor and a live preview. "Generate" asks an agent to draw the diagram from the codebase.

**Flow.**
- Diagrams are files at `.ucch/diagrams/*.mmd` in the project, versioned with the code and read by every agent as project knowledge.
- `POST /api/projects/:hash/diagrams/:kind/generate` runs a native-loop job (counted against `AGENT_MAX_NATIVE_TOTAL`), and `GET` reports its state.
- The output goes through `mermaid-repair.ts`, so model-written labels parse.
- The preview renders Mermaid in `strict` security mode and keeps the last good drawing while the source is invalid.

---

## 17. Tasks board

**UI.** `/{ws}/p/{project}/tasks`: a Kanban board with columns **Idea → Research → Ongoing → Verification → Done**.
- People create cards (title, description, references: URLs, files and uploads) and drag them between the columns a person owns. The middle columns belong to the AI.
- A card shows its stage and status (`idle`, `running`, `needs_input`, `failed`). Its detail dialog shows the request, the research brief, the verifier's verdict, and the feedback box.

**Pipeline** (`task-pipeline.ts`), run as the project owner on the board's provider and model (project preference), or the owner's default:
1. **Research**: a "Task: <title>" thread runs a research prompt that makes no changes and writes a brief (`research` mode on the built-in loop).
2. **Ongoing**: the same thread does the work, with the brief and a digest of the project's documentation.
3. **Verification**: a separate "Verify: <title>" thread checks the work against the card and replies with a verdict. With the workspace's "verify with OMP" setting, OMP's `task` agent verifies and cites file and line.
4. **Passed** → Done. **Failed** → `needs_input`: the person answers why (`POST …/tasks/:id/feedback`), and the next round gets the verdict and the answer. An error → `failed`, with a Retry button (`POST …/retry`).

**Automation** (`PUT …/task-settings`): "Auto Run Tasks" moves Idea cards to Research on chosen weekdays at a time in a timezone (`task-scheduler.ts`). A run missed by a restart still starts within a grace window.

**Conflicts.** Edits are optimistic and per-field. The server refuses only when a field you changed was changed by someone else meanwhile (`field-guard.ts`).

---

## 18. Timeline

**UI.** `/{ws}/p/{project}/timeline`: a Gantt chart. A task list on the left and bars on the right share one row height. Drag bars to move or resize them. Each task has a title, start and end dates, progress, a colour and an optional dependency, edited in a dialog.

**Flow.** `GET/POST /api/projects/:hash/timeline/tasks`, `PATCH/DELETE …/:taskId`. Writes are optimistic, guarded per field like the Tasks board, announced as `timeline.changed`, and logged.

---

## 19. Database manager

**UI.** `/{ws}/database`: a phpMyAdmin-style manager for MySQL/MariaDB and PostgreSQL servers saved in the workspace.
- **Connections**: add by fields or by pasting a URL. The connection is tested on save, and the password never comes back. Edit and remove connections.
- **A server**: list, create, drop, back up and import databases.
- **A database**: Structure (tables with sizes), SQL console (statement by statement, a result per statement), Export (whole database or ticked tables as SQL; one table as CSV), Import (SQL script or CSV into a table; reports where it stopped), Permissions (MySQL users or Postgres roles; grant and revoke).
- **A table**:
  - Browse: a paginated grid with inline edits, insert, update and delete. An edit is refused if the row changed meanwhile, and both versions are shown.
  - Structure: columns, indexes and foreign keys, with add, change and drop, plus `SHOW CREATE`.
  - Insert.
  - Operations: rename, truncate, drop. Destructive actions need the name typed.

**Flow.** `/api/workspaces/:id/database-connections`, `/api/database-connections/:id[/databases[/:db]]`, and the manager under `/api/database-connections/:id/db/:db/*` (see [`reference.md`](./reference.md#http-api)). Each request opens and closes its own connection. Identifiers are quoted and values bound. Exports stream to a file.

**Dev databases.** In the container, projects reach the embedded Postgres (`127.0.0.1:5432`) and, with `ENABLE_MYSQL=true`, MariaDB (`:3306`) as the `dev` user. The `dev` user may create databases but can't reach the harness's own database.

---

## 20. Activity log

**UI.** `/{ws}/p/{project}/activity` for a project, and the account-level feed (`GET /api/activity`), with filter chips by action.

**Flow.** Every command and every successful REST write produces an `audit_log` row and a live `audit.recorded` event. REST writes are described by `route-audit.ts`; routes with richer entries write their own (notes, files, tasks and timeline carry diffs). Bodies are never logged: no key values, passwords or SQL. Repeated saves of one thing by one person fold into one line.

---

## 21. Public sites

**UI.** Project Preferences or the notes' settings: turn on the **public site**. Its address is `/shared/{slug}`, where the slug is the project's name plus six random characters. The slug is minted once and kept. The site shows, read-only:
- **Notes**: the same renderer as the editor, locked (`/shared/{slug}/notes/…`).
- **Documents**: the project's files, a tree plus a highlighted viewer (`/documents?path=`).
- **Timeline**: git history grouped by day (`/timeline`).

**Flow.** `GET/PATCH /api/projects/:hash/public` toggles the site. The site reads `/api/public/:slug[/notes|/files|/file|/log|/uploads/:id/content]` with no session, rate-limited to 120 requests a minute per address. When the site is off, those routes answer 404.

---

## 22. Settings and personalisation

**Account Setting** (from the profile menu, `/setting/{page}`; these follow the person across workspaces):

| Page | Holds |
|---|---|
| `account` | name, email, password, avatar (§1) |
| `api` (API Management) | GitHub token, OpenRouter key, Resend key (§12) |
| `providers` (Agent Providers) | Claude Code, Codex and Custom cards: install state, sign-in, token, sign-out (§5) |
| `usage` | the person's tokens and cost, and storage per project |
| `activity` | the account's own activity feed (§20) |
| `theme` | light/dark/system, accent hue and palette, syntax colours with a live preview, saved presets |

**Workspace Settings** (`/{ws}/workspace-settings/{page}`; each member sees every page, and controls their role can't use are left out):

| Page | Holds |
|---|---|
| `general` | default model and provider, agent permission mode, editor and file-tree font sizes, modal keybindings |
| `members` (Members & Roles) | members, roles, per-member project and session permissions (§2) |
| `sharing` | invite links (§2) |
| `harness` (Harness Subscription) | credential policy, the workspace's own credentials, and agent settings: auto-handoff, bridge, memory, isolated fan-out, verify with OMP (§2, §8, §9) |

Browser-only preferences (font sizes, keybindings, theme presets, document width) live in `localStorage` and apply immediately.

**Quick menu** (search field and palette): create projects, sessions, todos, workspaces and databases; jump to projects; switch workspaces. Unavailable actions show disabled with the reason.

---

## 23. App shell, PWA and offline

- **Shell**: an icon rail (Dashboard, Connections, Publish, Todo; settings from the profile menu), a section panel, a header with breadcrumbs and the project's view switcher, and a collapsible right column (files). When the sidebar is collapsed, hovering a rail icon shows its panel as a flyout. There's a skip link for keyboard users.
- **Instant navigation**: every click paints the target page's skeleton in the same frame. Recent projects' content comes from the persisted cache.
- **PWA** (`NEXT_PUBLIC_PWA=1`): installable (manifest and icons), with a Serwist service worker. `/offline` lists recently visited pages that are cached. An **update toast** appears when a new `BUILD_ID` is deployed.
- **Health**: `/health` (server, database and web) and `/healthz` (web).

---

## 24. Observability (operators)

- `GET /metrics`: Prometheus text (event loop, memory, GC, engine queue, WebSocket, HTTP by route, web requests by kind, DB pool, per-service and per-child memory and CPU, OOM kills, web vitals by page template). Loopback only unless `METRICS_TOKEN` is set.
- **Watchdog alerts** to the log and `ALERT_WEBHOOK_URL` (§12 of [`solutions.md`](./solutions.md#12-operations-limits-alerts-metrics)).
- `scripts/pg-top.sh`: the slowest statements from `pg_stat_statements`.
- **Load testing**: `scripts/load/` (load generator, profile, summariser, a fake Claude CLI, a mock OpenRouter); see `scripts/load/README.md`.

---

## Open work

### Defined but not working

| Item | State |
|---|---|
| **Per-turn checkpoints, revert and fork** | `thread.revert`, `thread.fork`, `checkpoint.captured` and `checkpoint.reverted` exist in the protocol, `decide()` and the projections. Nothing captures a checkpoint, so revert always answers "this turn has no checkpoint to revert to". Fork creates an empty "Fork" thread without the conversation. Nothing in the UI calls either. |
| **Project containers** | `project.start` / `project.stop` and `container.state_changed` describe per-project Docker containers, which aren't built. Everything runs in the one container as the `node` user. `file.write`, `git.commit` and `git.push` as *commands* require a running container and so always refuse. The real file and git operations are the REST routes (§10, §12). |
| **Published previews** (`pv-{hash}`) | `preview.publish` / `preview.delete`, the `previews` table and the hostname grammar exist. No build of a frozen commit preview exists, and `preview.published` is never emitted. Live previews (§14) work. |
| **Publish** and **Todo** rail sections | placeholder pages (`SectionPage`) |
| **References** tab of the documentation | a placeholder |
| **Resend key** | stored and encrypted, used by no feature yet |
| **Manage page** uptime and context figures | placeholders, labelled as such |

### Open tasks

- **OMP rollout**:
  - OM8.1: settings UI for the OMP toggles beyond the workspace harness page.
  - OM8.2: an optional `omp-login` terminal for subscription logins in OMP, with a terms warning.
  - OM8.3: OMP in metrics and resource sampling.
  - OM8.4: load test with OMP in the mix.
  - OM8.5: `OMP_ENABLED` on by default.
  - OM8.6: a version-bump procedure (re-record the fixtures, update the SHA-256 and `PI_NATIVES_DIR` warmup).
  - OM8.7: retire the native loop once no thread is bound to it (`NATIVE_LOOP_FALLBACK=false`, then delete).
- **Performance leftovers** (2026-10-27 re-measure):
  - sign-in triggers 19 RSC requests (target 15);
  - cold-data clicks reach 703 ms p95 (target 600);
  - a 2,000-token answer takes 696 frames (target 675).

  One-join state loading in the engine (PF1.12) was measured at ~0.5% and dropped: the cost is in the append.
- **CI**: confirm `ci.yml` and `image.yml` run green on GitHub and that Dokploy deploys from the pulled image with no build on the VPS.
- **Isolation**: a separate UID or container per project, so users can't read each other's workspaces and CLI logins. The `Executor` / `ProcessHost` interfaces are the seam.

### Backlog (ideas)

- Manage projects: share a project with other users; storage usage and git repository settings per project.
- Switch theme by time of day, with a 30-second transition at a time the user sets.
- Notify when a task completes.
- Undo (Ctrl+Z) for drag-moves in the file tree.
