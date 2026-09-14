# Tool calling and the file system — implementation checklist

**Execution list for [`idea.md`](idea.md) · Phase 5 of [`plan.md`](plan.md)**

Ten stages, ordered by dependency. Each ends at something demonstrable. Prefer finishing a stage's check over starting the next.

---

## Stage 0 — Documents

- [X] `documentation/idea.md` — the design
- [X] `documentation/todo.md` — this list
- [ ] Note the OpenRouter divergence from §6.4's Anthropic-SDK assumptions in `plan.md`'s status table

---

## Stage 1 — Foundations

Unblocks cancellation and turn accounting. Two long-standing bugs live here, and nothing downstream can be finished correctly while they stand.

- [X] Move `normalizeWorkspacePath` from `apps/server/src/decide.ts` to `packages/protocol/src/paths.ts`; re-export from `index.ts`; update the import in `decide.ts`
- [X] Add `turn.started { threadId, turnId }` to the `DomainEvent` union in `packages/protocol/src/events.ts` — **not** transient
- [X] Project `turn.started` in `apps/server/src/engine.ts`: insert the `turns` row (`id: turnId`, `threadId`, `seq`) and set `threads.status = "running"`
- [X] Give `thread.cancel` a `cancelling` status transition to project — via a second new event, `thread.cancel_requested { threadId }`: `threads.status` is a projection, so a transition with no event could not be replayed
- [X] `apps/server/src/config.ts`: add `AGENT_MAX_ITERATIONS` (default 25) and `AGENT_ALLOW_HOST_SHELL` (default false); refuse to load the `shell` plugin under `NODE_ENV=production` without it — the rule is `shellPluginEnabled(config)`, checked by the registry in Stage 4
- [X] Test: after `thread.send`, `threads.status === "running"` and exactly one `turns` row exists
- [X] Test: a second `thread.send` on a running thread fails with `conflict` — the guard that has never once fired

Two things the list did not call for, both consequences of the above:

- [X] `applyProjection` is exported and the agent reactor's `emit` now runs it — its appends passed a no-op projection, so `turn.started` would have been logged and never projected
- [X] Boot resets threads left in `running`/`cancelling` by a previous process — a turn does not survive a restart, and with the guard now working those threads would refuse every later message

**Check:** `thread.cancel` on a running thread no longer returns `conflict`.

---

## Stage 2 — Tool calling over the wire

Pure transport work in `apps/server/src/openrouter.ts`. No agent behaviour yet.

- [X] Replace `ChatMessage` with the four-member union; export `ToolCall`
- [X] Add `tools`, `toolChoice`, `plugins` to `CompletionRequest`; add `toolCalls`, `annotations` to `CompletionResult`
- [X] Spread `tools`/`tool_choice` into the body **only when non-empty** — an empty array is not the same as absent to several providers
- [X] Accumulate `delta.tool_calls` into a `Map<index, {id, name, args}>`; never overwrite a set field with an empty one
- [X] Finalise: sort by index, synthesise a missing `id` as `call_${index}`, normalise `arguments: ""` → `"{}"`
- [X] Fix the frame split: `/\r?\n\r?\n/` rather than `indexOf("\n\n")`
- [X] Fix the dropped tail: flush the residual buffer through the same handler once the stream ends
- [X] Map `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens` onto `TokenUsage.cacheReadInputTokens` / `cacheCreationInputTokens`, currently hardcoded to zero
- [X] Tests: arguments split mid-token · index 1 before index 0 · `id` after arguments · zero-arg `""` · a frame with no trailing blank line · CRLF frames

Three more the list did not call for, all in service of the items above:

- [X] Send `usage: { include: true }` — OpenRouter reports no cache or cost figures without it, so the canary would have read zero for ever and been read as a tuning problem
- [X] `CompletionResult.costUsd` from the same accounting block; `agent.turn_completed` no longer hardcodes zero
- [X] An `error` object arriving mid-stream on a 200 now throws instead of returning an empty reply, and the reader is cancelled on the way out

**Check:** a recorded two-call parallel SSE fixture reconstructs byte-for-byte.

---

## Stage 3 — `packages/agent` skeleton

- [X] `package.json` (`@ucch/agent`, deps `zod` and `@ucch/protocol`), `tsconfig.json` matching the sibling packages, `src/index.ts`
- [X] Add `@ucch/agent` to `apps/server/package.json`
- [X] `src/executor.ts` — `Executor`, `ExecResult`; plus `ExecInterruptedError`, so a timeout keeps the output the command managed to print rather than growing `ExecResult` a fifth field
- [X] `src/executors/host.ts` — `HostExecutor(root)`: `spawn` with argv, timeout then `SIGKILL`, output clamp, and `resolve()` rejecting anything outside `root()`
- [X] `src/schema.ts` — `toJsonSchema()` over `zod/v4`'s `toJSONSchema`; strip `$schema`; **throw at module load** if a tool input uses `.optional()` instead of `.nullable()`
- [X] `src/registry.ts` — `Tool`, `ToolContext`, `ToolResult`, `AnyTool`, `defineTool()`, the frozen `ALL` array, `toolsFor(preset)`, `schemasFor(preset)` with a per-preset cache
- [X] Tests: `resolve()` rejects `../`, absolute paths, NUL bytes, and `a/../../b`

Two hardening choices made while writing the executor:

- [X] The child gets a rebuilt environment, not the server's — otherwise `bash` reads `SECRET_KEY` and `DATABASE_URL` out of `env`
- [X] It runs in its own process group and is killed as one, so a backgrounded process cannot outlive the tool call that started it

**Check:** `schemasFor("standard")` called twice serialises identically — the prompt-cache canary.

---

## Stage 4 — The tools

Each with a unit test against a temporary fixture tree.

- [X] `tools/fs.ts` — `read_file` (line-numbered, offset/limit, clamped), `list_dir`, `write_file` (emits `file.changed`), `edit_file` (exact replace, error unless the match is unique)
- [X] `tools/search.ts` — `glob` via `rg --files -g`; `grep` via `rg --json` formatted as `file:line: text`, with context lines and a match cap
- [X] `tools/system.ts` — `current_time` via `Intl.DateTimeFormat`, no subprocess; `ping` with fixed argv and a host regex so the argument can never become a flag
- [X] `tools/shell.ts` — `bash` as `["bash","-lc",cmd]`, cwd pinned, 120 s default cap, ~30 KB head-and-tail clamp, gated behind `AGENT_ALLOW_HOST_SHELL`
- [X] `tools/web.ts` — `web_search` as a sub-call with `plugins:[{id:"web"}]` and no tools, returning `url_citation` annotations; `web_fetch` restricted to http/https with private and loopback ranges refused
- [X] Register all eleven in `ALL`, in the canonical order

Three structural changes this needed:

- [X] `src/completion.ts` — the model-call vocabulary (`ChatMessage`, `ToolCall`, `Annotation`, `CompletionResult`) moved here and re-exported by `openrouter.ts`, because `web_search` needs it and this package may not reach into `apps/server`. `ToolContext.complete` is the injected port, which is also what Stage 5's scripted fake will drive
- [X] `src/tool.ts` — `Tool`, `ToolContext`, `ToolResult`, `defineTool` split out of `registry.ts`: the registry imports the tools and the tools import `defineTool`, and one file holding both halves is a cycle
- [X] The shell gate is `toolsFor(preset, { allowHostShell })`, orthogonal to the preset and cached per combination, rather than a fourth preset

**Check:** every tool returns a non-empty string, and every path-taking tool refuses a path outside the workspace.

---

## Stage 5 — The loop

- [X] `src/session-log.ts` — fold the event log into `ChatMessage[]`; look results up by `toolUseId` and emit them in the assistant's `tool_calls` order; a missing result becomes the *"Interrupted before this tool ran."* placeholder
- [X] `src/prompt.ts` — assemble stable → volatile (harness rules → stack → `AGENTS.md`/`CLAUDE.md` → `rg --files` tree capped ~200), **no timestamps**, each part emitted as `context.injected` with its `source`
- [X] `src/loop.ts` — the iteration loop: `agent.message` durable **before** any tool runs, `agent.tool_use` batched into one append, `Promise.all` over the calls, results pushed in call order, `MAX_ITERATIONS` → `stopReason: "max_iterations"`
- [X] `runTool` as a **total** function — unknown tool, malformed JSON, schema violation, throw, timeout and abort all become `isError: true`; never a dropped result
- [X] Store the raw `arguments` string verbatim in the `tool_use` block, alongside the parsed `input`
- [X] Rewrite `apps/server/src/agent.ts` around the loop: emit `turn.started` first, one `AbortController` per thread in a `Map`, `thread.cancel` aborts it, `finally` clears it
- [X] Delete the "You cannot run commands or edit files yet" system prompt
- [X] Construct the executor and registry in `apps/server/src/index.ts` — per turn rather than once, since the workspace root is per project; the registry options are decided at boot from `shellPluginEnabled(config)`
- [X] Tests: a session-log round trip with two parallel calls · a log truncated mid-turn still rebuilds to a valid message list · every `runTool` error path

Two smaller things this turned up:

- [X] The reactor `mkdir -p`s the project workspace before the turn, so the file tools work sanely on a project the clone reactor has not reached yet
- [X] A batch of nothing but transient events skips the projection, and with it the empty transaction the event store was opening once per streamed token

**Check:** a scripted fake `streamCompletion` drives a two-iteration tool conversation through to `turn_completed`, with the whole event sequence asserted.

---

## Stage 6 — Clone reactor

- [X] `apps/server/src/clone.ts` — a `DrainableWorker` that, on `project.created`, runs `git clone --depth 1 --branch <defaultBranch>` into `WORKSPACE_ROOT/{projectId}`
- [X] Stack detection from marker files (`artisan` → laravel, `next.config.*` → nextjs, `vite.config.*` → vite, `package.json` → node, `index.php` → php, else static) → `project.cloned { headSha, stack }`
- [X] Confirm the existing `project.cloned` projection updates `projects.stack` — it does; now asserted rather than assumed
- [X] Create `WORKSPACE_ROOT` at boot if absent; fail loudly if it is not writable
- [X] Register it alongside the agent reactor in `index.ts`, and stop it after the engine on shutdown
- [X] Test: clone a small fixture repo, `drain()`, then assert files on disk, `project.cloned` in the log, and `projects.stack` updated

Four hardening choices the list did not call for, all of them things a real clone runs into:

- [X] `ext::sh -c …` parses as a URL and executes as a shell, so the transport goes through a whitelist (`https`, `http`, `ssh`, `git`, `file`) rather than straight to git
- [X] `GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS` and `ssh -oBatchMode=yes`: a private repository must *fail*, not block the worker on a credential prompt no one is there to answer. The environment is rebuilt rather than inherited and both config files are pinned to `/dev/null`, so `SECRET_KEY` is unreadable and a host `insteadOf` rule cannot rewrite what is fetched
- [X] A clone whose `--branch` is absent from the remote retries on the remote's own HEAD — `defaultBranch` defaults to `main`, and a repository on `master` is not an error worth failing a project over. The target is cleared before the retry, since git leaves a partial tree behind
- [X] Idempotent: an event redelivered onto a directory that is already a working tree re-detects and re-emits rather than failing on a non-empty target

**Check:** creating a project leaves a real working tree on disk.

---

## Stage 7 — Chat UI for tools

- [X] Render `agent.tool_use` and `agent.tool_result` in `apps/web/src/components/project-chat.tsx` as collapsible rows — name, input, result, duration, error styling. §6.7: "each tool call is an expandable row with input and result"
- [X] Fold tool events into `toMessages()` under their `turnId`, so they sit inside the assistant bubble rather than beside it
- [X] Show `stopReason: "cancelled"` and `"max_iterations"` distinctly from a failure — a muted note, not the red border `turn_failed` gets
- [X] Add a Stop button while a turn is running, dispatching `thread.cancel` — in the Send button's own position, so there is nowhere else to look

Four things this turned out to need:

- [X] The fold moved to `apps/web/src/lib/chat-messages.ts`, pure and event-typed only, because it is the one part of the view with rules worth testing without a renderer. `describeStop`, `summariseInput` and `formatDuration` live with it
- [X] An assistant turn is now an ordered list of **parts** — prose, tool row, prose — rather than one `text` field. The old shape held a single string per turn, so the second iteration's `agent.message` overwrote the first and a tool turn lost its opening line; ordering is also what puts the rows *inside* the bubble rather than beside it
- [X] `running` comes from `turn.started` versus `turn_completed`/`turn_failed` rather than from "the last bubble is streaming", so a reload mid-turn still offers Stop, and the composer is disabled while a turn is in flight rather than sending a message the server would refuse with `conflict`
- [X] Tool calls arriving inside `agent.message`'s content are ignored: the same calls arrive as durable `agent.tool_use` events, and drawing both would double every row

**Check:** asking a question about the files shows the tool rows streaming in, then the answer.

---

## Stage 8 — Verification

Run against Postgres on `localhost:55432`, the server on `:3001`, the web app on `:3000`, and a real OpenRouter key, on 2026-09-06. The project under test is a real `https://github.com/expressjs/express.git` clone.

- [X] `pnpm test` (303) and `pnpm typecheck` clean across every package
- [X] Executor tests against a temp dir, including a refused path outside root — `executors/host.test.ts`
- [X] End to end in the browser, with the key already in `/setting`:
  - [X] *"What files are in this project?"* → `list_dir`, and an answer that names the real files
  - [X] *"What time is it?"* → `current_time` called rather than hallucinated
  - [X] *"Ping google.com"* → real ICMP output, 3 packets, 0% loss
  - [ ] *"Search the web for the latest Next.js release"* → **OpenRouter's `web` plugin returns 500 for this account**, on every model and both streaming and not, for a minimal hand-written request as much as for ours. Nothing to fix here: `web_search` reports it as an errored tool result, the model recovers with `web_fetch`, and the turn completes normally. Retry when the provider is well
  - [X] *"Add a /health route"* → `read_file` → `edit_file` → a real four-line diff in `examples/hello-world/index.js` on disk
- [X] In Postgres, the event sequence for a tool turn reads `user.message → turn.started → context.injected ×3 → agent.message → agent.tool_use → agent.tool_result → agent.message → agent.turn_completed`, with `file.changed` between the write tool's use and its result
- [X] Cancellation: `bash sleep 120`, then Stop — the dispatched call still recorded its result (*"bash was cancelled"*), `stopReason: "cancelled"` through `turn_completed` rather than `turn_failed`, and the thread back to `idle`
- [X] Cache canary: 18 of 20 consecutive turns read ~4.4k cached tokens of a ~4.6k prompt, and a turn's cost fell from $0.0165 to $0.0015

**The canary read zero, and it was right to.** Anthropic and Google cache only what a request marks with `cache_control`, and the harness marked nothing anywhere — §6.4's stable → volatile prompt was being assembled for a cache that was never being asked for. The fix is in `apps/server/src/openrouter.ts`:

- [X] `withCacheBreakpoints()` marks two points for those providers — the system prompt, and the last user message — so every earlier turn becomes a prefix the next one reads back. OpenAI-family models cache on their own and are passed through untouched, as is every message a breakpoint does not land on
- [X] Five tests over the request body, including the empty-content case a provider rejects outright

Two things the environment needs, neither of them code:

- [X] `WORKSPACE_ROOT=/srv/ucch/workspaces` does not exist and `/srv` is root-owned, so the server now refuses to boot — which is Stage 6's "fail loudly" working as intended, and was previously a turn that failed at its first file tool instead. Create it (`sudo mkdir -p /srv/ucch/workspaces && sudo chown $USER /srv/ucch/workspaces`) or point `WORKSPACE_ROOT` somewhere writable
- [X] The verification ran with `WORKSPACE_ROOT` overridden to a scratch directory, so the express clone and its `/health` edit live there rather than under `/srv`

## Stage 9 — The real workspace in the browser

- [X] `GET /api/projects/:hash/files` and `/file?path=` serving the real workspace
- [X] Point `files-panel.tsx` and `code-editor.tsx` at it; delete `apps/web/src/lib/dummy-files.ts`
- [X] Refresh the tree live from `file.changed` events

The list stopped at reading; editing was the point of showing the files at all:

- [X] `apps/server/src/files.ts` — `WorkspaceFiles`, the browser's side of the same directory the agent's `HostExecutor` runs in. One `resolve()`, used by every method, confining each path to `WORKSPACE_ROOT/{projectId}`
- [X] `PUT /file` (save), `POST /file` (create a file or a folder, refusing to clobber), `DELETE /file?path=` — each emitting `file.changed`, the same event the agent's own `write_file` emits, so a person's edit and a model's edit reach the UI by one path
- [X] `.git` hidden and `node_modules` listed but not walked; a 5,000-entry cap; 1 MB read cap; binary files refused as 415 rather than mangled through a text editor
- [X] Symlinks are listed but never followed: `realpath` is checked against the workspace root on every read, write and delete, because `resolve()` is lexical and cannot see a link planted inside the tree
- [X] `:w`, `:wq` and ctrl-S write through the server; a tab is dirty while its buffer differs from what was last read or written; an open file the agent rewrites is reread underneath the editor unless you have unsaved edits of your own
- [X] Delete from the tree, behind a confirmation, taking the path's tabs and buffers with it
- [X] 27 tests over the path rules, the tree, and every read/write/delete path, including four that plant a symlink out of the workspace and prove it is refused

**Check:** the tree shows what `ls` shows, and a file saved in the browser is on disk.

---

## Stage 10 — Terminals

- [X] `apps/server/src/terminals.ts` — a `bash` per tab, started in the project's workspace, killed with its tab. `cd` persists because it is one shell rather than one per line
- [X] Behind `shellPluginEnabled(config)`, the same gate as the agent's `bash` tool: the same host shell reached by a different route, and one being opt-in in production while the other was not would be a distinction without a difference
- [X] The environment is rebuilt rather than inherited (`SECRET_KEY` and `DATABASE_URL` are one `env` away otherwise), `HOME` is the workspace, and the shell runs in its own process group so a backgrounded command dies with the tab
- [X] `terminal.create` carries a client-minted `terminalId`: output is transient, so the create returns no event to learn an id from, and the client must be subscribed before the first prompt is printed
- [X] `decide()` now checks the project's owner on `terminal.create`, and a session refuses input or a close from anyone but the user who opened it
- [X] The topbar is a three-way toggle — Chat · Files · Terminal — and the tree is hidden in the terminal, which is a full-width view
- [X] Tabs with a `+` after the rightmost one; several shells per project, each with its own scrollback and command history, kept alive while you read the files
- [X] 8 tests, driving a real shell: cwd, `cd` persistence, a failing command, close, and the refusals

**No pty.** `node-pty` is a native dependency and the container runtime brings its own, so the shell is spawned with pipes: no line editing from the shell, no ctrl-C, and nothing full-screen. The view says so in a line under the input rather than leaving it to be discovered.

**Two things this leaves open:**

- [ ] A browser tab closed outright drops the socket without closing its shells; they are reclaimed by the 15-minute idle timeout rather than at once. Tying a session's lifetime to the connection that created it is the fix
- [ ] The shell is not confined to the workspace the way the agent's tools are -- it starts there, and `cd /` works. The agent remains confined; the container runtime is what closes this for the human as well

---

## Stage 11 — Known gap

- [ ] Projects created before Stage 6 have no clone: their workspace directory is made empty by the agent reactor on first message, so the tree is empty and the model reports "no project-specific context". Only a re-created project clones. A `project.resync` command that runs the clone reactor against an existing project would close it
