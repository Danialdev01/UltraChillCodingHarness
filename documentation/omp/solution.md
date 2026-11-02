# OMP in UCCH: solution

**Status:** design · **Date:** 2026-10-31 · **Why:** [`plan.md`](./plan.md) · **Tasks:** [`todo.md`](./todo.md)

This is the build spec. It plays the same role for OMP that [`../integration-spec-1.md`](../integration-spec-1.md) played for the Claude Code and Codex providers. Read [`plan.md`](./plan.md) §3 (goals) and §8 (risks) first.

Conventions:
- **Doc refs** point to <https://omp.sh/docs/…> pages, read on 2026-10-31.
- **(verify in OM0)** marked behaviour the docs do not settle. The OM0 spike answered each one in [`spike-report.md`](./spike-report.md) (OMP 18.14.1), and the sections below were corrected to match; **(OM0: …)** marks where an answer changed the design.
- **Code refs** are `path:line` at commit `c359c98`.

---

## §0 Safety rules (read first)

### 0.1 Billing
- CLI turns stay on subscriptions. `FORBIDDEN_ENV` (`packages/providers/src/types.ts`) is unchanged for `claude` and `codex`.
- OMP processes get an **explicit allowlist** of credential variables, not the CLI deny list. By default the allowlist is `OPENROUTER_API_KEY` alone: the account's decrypted key, the same one the native loop uses today (`apps/server/src/agent.ts:590`, `#decryptKey`).
  - `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_CODEX_OAUTH_TOKEN` and every other provider variable on [env](https://omp.sh/docs/env) are removed.
  - A run refuses to start if any of them is present. This is `forbiddenEnvFor("omp", env)` (§12.2).
- An OMP subscription login (`anthropic`, `openai-codex`) happens only through the optional `omp-login` terminal (§12.5). It is stored in the subject's `omp/` directory, never in the environment, and comes with a warning (plan §8).

### 0.2 Secrets and memory
- Memory never auto-retains tool output from CLI turns.
- `mnemopi.llmMode` is a per-workspace setting.
- OMP's own warning is surfaced in the settings card: "Do not ask omp to remember secrets" ([memory](https://omp.sh/docs/memory)).

### 0.3 A cloned repository does not configure OMP
UCCH clones untrusted repositories. `claudeArgv` already refuses project settings (`--setting-sources user`, `packages/providers/src/claude.ts:101`), and `codexArgv` refuses project rules (`--ignore-rules`, `codex.ts:64`). OMP gets the same rule.

**What OMP can discover from the launch directory:**

| Source | Doc | Risk | Control |
|---|---|---|---|
| `<cwd>/.omp/config.yml` | [settings](https://omp.sh/docs/settings) | sets `tools.approval.bash: allow`, `tools.approvalMode`, providers, … | always read; nothing turns it off. `--approval-mode` outranks its `approvalMode`, and the overlay outranks it **only for keys the overlay names**: `tools.approval` is a record and records merge, so a project's `bash: allow` survives an overlay that does not name `bash` **(OM0)**. The overlay therefore writes the whole `tools.approval` table, every model role and every paid or outward-facing switch (§4). A project cannot define or move a provider: `.omp/models.yml`, a root `models.yml` and `providers.<id>.baseUrl` are not read (OM2.5), so the key only goes to OpenRouter |
| `.omp/hooks/pre\|post/*.ts` | [hooks](https://omp.sh/docs/hooks) | arbitrary code as the server user | `--no-extensions` (OM0: covered). `PI_CONFIG_DIR` renames only the *user* directory, not project `.omp/`, so it is not used |
| `.omp/lsp.json`, root `lsp.json` | [code intelligence](https://omp.sh/docs/code-intelligence) | arbitrary `command` | both load until `--no-lsp` (OM0), so untrusted projects run `--no-lsp` |
| `.omp/dap.json`, root `dap.json` | [debugging](https://omp.sh/docs/debugging) | arbitrary `command` | load under every flag; untrusted projects get `debug.enabled: false` in the overlay, which stops both (OM0) |
| `.omp/mcp.json`, root `mcp.json` / `.mcp.json` | [mcp](https://omp.sh/docs/mcp) | spawns servers | overlay `mcp.enableProjectConfig: false` (OM0: covered). `.claude/settings.json` `mcpServers` is not read by OMP |
| `.omp/agents/` | [subagent authoring](https://omp.sh/docs/subagent-authoring) | model-visible prompt, own tools and model | listed to the model under every flag, but not runnable under `--no-extensions` (OM0: "Unknown agent"). The guard hook also refuses a `task` call naming an agent that is not bundled |
| `.omp/RULES.md`, `.omp/skills/`, `.claude/skills/`, `.claude/commands/`, `AGENTS.md`, `.claude/CLAUDE.md` | [context files](https://omp.sh/docs/context-files), [skills](https://omp.sh/docs/skills) | model-visible instructions | `--no-rules`; `skills.enableClaudeProject`, `skills.enablePiProject`, `skills.enableAgentsProject`, `commands.enableClaudeProject`, `commands.enableOpencodeProject: false`; `AGENTS.md` is still read, just as UCCH already passes AGENTS.md / CLAUDE.md up to 16 KB to the native loop. `.claude/CLAUDE.md` is not: the overlay's `disabledProviders` (OM6.8) turns off the `claude` source that reads it (measured in OM7.6) |
| plugins / marketplaces | [plugins](https://omp.sh/docs/plugins) | trusted code | `--no-extensions`; no `--plugin-dir` |

**Trust levels:**
- A project is **untrusted** by default. OM0 found sources that cannot be switched off, so untrusted projects run OMP with `--no-lsp` and `debug.enabled: false`, and the guard hook enforces the rest.
- A person can mark a project **trusted** in project settings. Only then are the repository's own `.omp/` / `.ucch-omp/` agents, LSP and DAP config allowed.
- **As built (OM7.6).**
  - **Column.** `projects.omp_trusted` (migration 0030), off by default. `GET /api/projects/:hash/omp-trust` shows it to any member, with whether they may change it. `PATCH` takes `workspace.manage`, as deleting the project does, and is audited as `project.omp_trust`. The project's Preferences tab has a "Trusted repository" card; a member who is not an admin sees it disabled.
  - **What it changes.** An OMP turn reads the column with the project row it already loads, so the next turn after a change follows it. Trusted, `ompArgv` drops `--no-lsp` and the overlay sets `debug.enabled: true`, with `debug` at its tier's policy (exec: asks under Normal). The bridge's calls follow the project too, from a turn or a terminal: their overlay, and `UCCH_OMP_TRUSTED=1` for `lsp` and `debug` (§10.2).
  - **What it does not.** `--no-extensions`, `--no-rules`, the guard hook and the overlay's project-source switches are the same either way, so a repository's hooks, MCP servers, skills, commands and rules stay off when it is trusted, and its agents stay unrunnable. Side calls with no use for a language server or debugger stay untrusted: compaction and handoff, the handoff brief, and end-of-turn retention.
  - **Measured.** The OM0.4 plant repository, run through UCCH's own overlay and `ompArgv` flags with the guard hook (spike report, "Measured later"): untrusted, none of the four `lsp.json` / `dap.json` plants loaded; trusted, all four did, and nothing else changed.

### 0.4 Isolation is not a sandbox
"Isolation is not a security sandbox" ([subagents](https://omp.sh/docs/subagents)). The trust boundary is the same as for today's CLI runs: the container, the scrubbed environment (`ProviderService.providerEnv`, `apps/server/src/providers.ts`), and the guard hook (§3.9).

---

## §1 Installing and pinning OMP

### 1.1 Image
- `Dockerfile` gets `ARG OMP_VERSION=<pinned>` and installs OMP into `/opt/omp`.
- **Route (OM0): the release binary** `omp-linux-x64` from `github.com/can1357/oh-my-pi/releases/download/v<version>/`, checked against a pinned SHA-256. It is self-contained (glibc only, no Bun). The install script can pin (`--binary --ref v<version>`, `PI_INSTALL_DIR`) but prefers a Bun install whenever Bun is on `PATH`, and resolves the file through a second service.
- `PI_NATIVES_DIR=/opt/omp/natives`, warmed at build time: OMP otherwise unpacks ~120 MB of native modules into `$HOME/.omp/natives/` on first start.
- Never `latest`: the RPC surface may grow "without a version change" ([rpc](https://omp.sh/docs/rpc)).
- Then `omp --version` runs as a build step, and the build fails if it doesn't print `OMP_VERSION`.
- `OMP_SKIP_SETUP=1` is baked into the run environment, so the first-run wizard never waits on stdin ([env](https://omp.sh/docs/env)).
- **Language servers and debug adapters** (§8) sit behind build args, so the image size is a choice:
  - `ARG OMP_LSP="typescript-language-server pyright"`
  - `ARG OMP_DAP="debugpy js-debug"`

### 1.2 Dev machine
- `curl -fsSL https://omp.sh/install | sh`, then `omp --version` ([quickstart](https://omp.sh/docs/quickstart)).
- `.env.development.example` gains `OMP_BIN=omp`.
- The dev machine does not have `omp` today, but `bun` (`~/.bun/bin/bun`) is present if the install needs it.

### 1.3 Config (`apps/server/src/config.ts`)
| Key | Default | Meaning |
|---|---|---|
| `OMP_BIN` | `omp` | binary path |
| `OMP_ENABLED` | `false` until OM8, then `true` | "Custom" runs on OMP |
| `NATIVE_LOOP_FALLBACK` | `true` until removal | allow `native` for threads already bound to it, and as an emergency switch |
| `OMP_BRIDGE_BIN` | `node <dist>/omp-bridge.mjs` | how the CLIs start the bridge |
| `OMP_TURN_TOTAL` | measured (§13) | server-wide cap on OMP processes |
| `OMP_WORKERS_PER_TURN` | `4` | `task.maxConcurrency` in the overlay |
| `OMP_BRIDGE_MAX_SECONDS` | `300` | `--max-time` for bridge calls |

### 1.4 Probe (`probeOmp`)
- Run `omp --version`, which sets `installed` and `version`.
- `authenticated` is true when the subject has an OpenRouter key, or when `omp/` holds a login.
- `authMode`:
  - `"api-key"` with the label "OpenRouter key". This is not the billing-surprise state the type's comment describes, because it is the intended route.
  - `"subscription"` for an `omp-login`.
- The type comment in `ProviderHealth` is updated to say that the meaning of `api-key` is per provider.
- `warnings` carries the terms warning when a subscription login is in use.

---

## §2 The RPC client: `packages/providers/src/omp-rpc.ts`

One class, used by `OmpProvider` (§3), the bridge (§10), the handoff builder (§5.4) and the reviewer (§9). It is built on the existing `ProcessHost` / `ChildHandle` / `splitLines` (`packages/providers/src/process.ts`), so a future `docker exec` host works unchanged.

```ts
export interface OmpRpcOptions {
  host: ProcessHost;
  argv: string[];            // from ompArgv()
  cwd: string;
  env: Record<string, string>;
  onFrame(frame: OmpFrame): void;     // every event / request frame, in order
  onStderr?(line: string): void;      // logged, never parsed
}

export class OmpRpc {
  static start(o: OmpRpcOptions): Promise<OmpRpc>;   // resolves on the `ready` frame
  request<T = unknown>(cmd: OmpCommand): Promise<OmpResponse<T>>; // id-correlated
  send(frame: OmpClientFrame): void;  // extension_ui_response, host_tool_result, host_tool_update
  close(): Promise<ExitStatus>;       // close stdin, await exit (rpc: "exits with code 0")
  kill(): Promise<void>;              // SIGTERM, then SIGKILL after 5 s
}
```

**Rules from [rpc](https://omp.sh/docs/rpc):**
1. Spawn, read stdout continuously, and **wait for `ready`** before any command. A timeout of 20 s fails the start with stderr attached.
2. Immediately send `{"type":"negotiate_protocol","protocolVersion":2}`, then reassemble `rpc_chunk` frames strictly, up to 64 MiB. If negotiation fails, stay on v1 (1 MiB per frame) and log it.
3. Every command gets a fresh `id` (`omp-<n>`). Responses are matched by `id` and **never by order**: `bash` runs concurrently. A response with `command: "parse"` and no `id` is a client bug, so it is logged loudly.
4. `prompt` resolving means **scheduled**, not done. Completion is `agent_end` with `isTerminal !== false`. A local slash command may finish with `response.data.agentInvoked === false` or a `prompt_result` frame.
5. Unknown frame types and unknown fields are passed through to `onFrame` and otherwise ignored. They are never an error.
6. Stdout is protocol only. Stderr goes to the server log at debug level and is kept as a 64 KB ring buffer for error messages.
7. Shutdown means closing stdin. OMP "rejects pending callbacks, finishes accepted commands, disposes the session, and exits with code `0`".
8. **Backpressure.** `onFrame` is synchronous and pushes into the provider's async queue, the same pattern `runCli` uses (`packages/providers/src/run.ts`). Host tool and UI requests are handled off the read loop, so a slow tool never stalls stdout.

`OmpFrame` and `OmpCommand` are hand-written TypeScript types covering the frames in the docs' tables, with an `[key: string]: unknown` index on each. They live in `omp-rpc-types.ts`. Fixtures recorded in OM0 (`packages/providers/src/fixtures/omp-*.jsonl`) back the tests.

---

## §3 `OmpProvider`: `packages/providers/src/omp.ts`

### 3.1 argv (`ompArgv`)

```ts
export function ompArgv(input: {
  bin: string;
  overlayPath: string;          // §4, written per run
  sessionDir: string;           // <creds>/omp/sessions/<projectId>
  model?: string;               // openrouter/<OpenRouter id> (OM0)
  effort?: ReasoningEffort;
  resumeToken?: string;         // OMP session id
  permissionMode?: AgentPermissionMode;
  appendSystemPrompt?: string;  // .ucch knowledge + UCCH rules
  trusted: boolean;             // §0.3
  guardHookPath: string;        // absolute; §3.9
  maxTime?: string;             // e.g. "45m"
}): string[] {
  const argv = [input.bin, "--mode", "rpc-ui",
    "--config", input.overlayPath,
    "--session-dir", input.sessionDir,
    "--approval-mode", approvalFor(input.permissionMode),
    "--no-extensions", "--no-rules", "--no-title",
    "--hook", input.guardHookPath];  // §3.9; the one hook that loads under --no-extensions
  if (!input.trusted) argv.push("--no-lsp");   // OM0: project lsp.json loads otherwise
  if (input.model) argv.push("--model", input.model);
  if (input.effort && input.effort !== "off") argv.push("--thinking", thinkingFor(input.effort));
  if (input.resumeToken) argv.push("--resume", input.resumeToken);
  if (input.appendSystemPrompt) argv.push("--append-system-prompt", input.appendSystemPrompt);
  if (input.maxTime) argv.push("--max-time", input.maxTime);
  return argv;
}
```

**Notes on the flags:**
- **`rpc-ui`, not `rpc`.** Approvals need it (§3.5). The flip side is that `rpc-ui` "disables PTY-backed shell execution" ([modes](https://omp.sh/docs/modes)). That is acceptable, because `CI=1` / `TERM=dumb` are already set for CLI runs. If OM0 shows that the confirm path does not need `rpc-ui`, use `rpc`.
- **`--no-title`** saves a `tiny` model call per session.
- **`--append-system-prompt`** works on resumed turns too, for the same reason `claudeArgv` sends it every turn. OMP reads its value as "text or file contents": a value that names an existing file is replaced by that file (measured with 18.14.1). Knowledge comes from the repository, so `ompArgv` always ends the value with a newline, which makes it text.
- **`--resume` in RPC mode works** with `--session-dir` (OM0). An unknown id exits 1 before `ready` ("Session … not found"); the provider fails the turn with that, and the reactor starts the thread on a fresh session next time.
- **`@file` arguments are rejected in RPC** ([rpc](https://omp.sh/docs/rpc)). The prompt and knowledge are sent as text.

### 3.2 Mappings

| UCCH | OMP |
|---|---|
| `permissionMode: strict` | `--approval-mode always-ask`: reads run, writes and exec ask ([approvals](https://omp.sh/docs/approvals)) |
| `normal` | `--approval-mode write`: reads and writes run, exec (`bash`, `eval`, `browser`, `task`) asks |
| `allow_all` | `--approval-mode yolo` |
| effort `low`, `medium`, `high`, `xhigh`, `max` | `--thinking low`, `medium`, `high`, `xhigh`, `max` |
| effort `off` or absent | no flag |
| `model` | `openrouter/<account model id>`, the OpenRouter id unchanged: `openrouter/anthropic/claude-sonnet-4.5` (OM0) |

**Under every mode** the overlay's `tools.approval` denies `ask`, `github`, `computer`, `generate_image`, `tts`, `hub` and `report_issue`, and `browser` unless the workspace enables it; `deny` "always wins". Every other tool gets its tier's policy for the mode, written out (§4). In 18.14.1 `browser` and `computer` are eval preludes, not tools, so the overlay also sets `browser.enabled` / `computer.enabled` (OM2.5).

### 3.3 Environment (`ProviderService.providerEnv("omp")`)
- Start from `terminalEnv()` as today, with `TERM=dumb` and `CI=1`.
- `PI_CODING_AGENT_DIR=<CREDS_ROOT>/<subject>/omp/agent` holds auth, settings, memories, agents and LSP config ([env](https://omp.sh/docs/env)).
- `OMP_WORKTREE_DIR=<CREDS_ROOT>/<subject>/omp/wt` keeps isolated workers off the shared `~/.omp/wt`.
- `OMP_SKIP_SETUP=1`.
- `OPENROUTER_API_KEY=<decrypted>`.
- `PI_TASK_MAX_OUTPUT_BYTES=65536` caps worker output.
- `PI_NATIVES_DIR` from the image (§1.1), so no turn unpacks native modules.

### 3.4 Event normalisation (`OmpNormaliser`)

**Two invariants:**
- The browser never sees an OMP-specific event (`types.ts` design rule).
- `agent.tool_use` / `agent.tool_result` pairs must match by `toolUseId`, because revert and the chat depend on it.

| RPC frame ([rpc](https://omp.sh/docs/rpc)) | DomainEvent (`packages/protocol/src/events.ts`) | Notes |
|---|---|---|
| `ready` | none | the start barrier |
| `get_state` response (`data.sessionId`), asked right after `ready` | `agent.session_started { provider: "omp", sessionId }` | before the prompt, like Claude's `system/init`; it becomes the thread's `providerSessionId` and the next `resumeToken`. OM0: no `session_info_update` is emitted for this |
| `message_update` · `assistantMessageEvent.type: "text_delta"` | `agent.text_delta { text: delta }` | |
| `… "thinking_delta"` | `agent.thinking_delta` | |
| `… "toolcall_*"` | none | streaming tool arguments are not shown; `tool_execution_start` carries the whole call |
| `… "error"` | held | ends as `agent.turn_failed` if there is no later recovery (`auto_retry_*`) |
| `tool_execution_start` | `agent.tool_use { toolUseId, name, input }` | tool names are mapped for the UI's icons (`bash`→`bash`, `edit`→`edit_file`, `write`→`write_file`, `read`→`read_file`, …); unknown names pass through. A `write` to `xd://<tool>` is a device call (OM0): it becomes `<tool>` with the parsed JSON `content` as input, and is never a file change |
| `tool_execution_update` | none | progress is not stored |
| `tool_execution_end` | `agent.tool_result { toolUseId, content, isError, durationMs }` | `content` is the text parts joined and truncated like the native loop's results; `durationMs` comes from the start/end timestamps |
| `message_end` (assistant) | `agent.message { content }` | text blocks as OMP sends them; a `toolCall` block becomes `tool_use { id, name, input, arguments }` (the name mapped as for `agent.tool_use`, `arguments` = OMP's `partialArgs`), the shape `session-log.ts` already reads. Used for display; resume goes through OMP's own session |
| `auto_retry_start` | `agent.retry { attempt }` | |
| `auto_compaction_start` | none | a transient "Compacting…" through the existing turn status |
| `auto_compaction_end` | `context.injected { source: "compaction", content, tokens }` | `content` is `result.summary` on the frame (OM0); `skipped: true` produces nothing. The method and `tokensAfter` are on the `compactionSummary` message (`get_messages`), not the frame |
| `extension_ui_request` `method: "select"`, `title` starting `Allow tool:` | `agent.permission_requested` | §3.5 (OM0: approvals are a `select`, not a `confirm`) |
| any other `select`, `confirm`, `input`, `editor` | answered `cancelled: true` | the UI has no surface for them; the `ask` tool is disabled in the overlay, because the chat is where questions go |
| `extension_ui_request` `notify`/`setStatus`/… | none | logged |
| `host_tool_call` | handled by the host-tool runner (§3.7); no event of its own | OMP sends `tool_execution_*` for host calls too (OM0), after the `host_tool_result`, so those rows produce the tool events |
| `subagent_lifecycle`, `subagent_progress` | `agent.subagent_started` / `_progress` / `_finished` (new, §6.1) | |
| `notice` | none | logged; `level: "error"` is attached to the turn's failure if one follows |
| `agent_end` with `isTerminal !== false` | `agent.turn_completed { stopReason, usage, costUsd }` | usage and cost from `get_session_stats` (requested on `agent_end`) as a delta against the turn's starting stats. `isTerminal: false` (`awaitingAsyncWork`) is a background task still running, not the end (OM0) |
| `prompt_result` with `status: "error"` | `agent.turn_failed { error }` | an API error mid-turn: OMP ends the turn normally and exits 0, so this frame, not the exit code, is the failure (OM0) |
| process exit ≠ 0, or `ready` timeout | `agent.turn_failed { error }` | the stderr ring buffer goes in the log, and a short reason goes in `error` |

Unknown frames produce nothing. The normaliser is a pure `(frame) => DomainEvent[]` plus a small state object, so it is tested exactly like `ClaudeNormaliser` against the recorded fixtures.

### 3.5 Permissions
- `extension_ui_request { id, method: "select", title: "Allow tool: <name>\n…", options: ["Approve", "Approve <name> for this session", "Deny"] }` becomes `agent.permission_requested { requestId: id, toolUseId, toolName, input, description }`. The payload has no tool call id; the tool is the most recent `tool_execution_start` without an end (approvals are sequential). `description` is the title's lines after the first.
- `AgentRun.answerPermission(requestId, reply)` sends `{ type: "extension_ui_response", id, value: reply.behavior === "allow" ? "Approve" : "Deny" }`. "Approve … for this session" is never sent: UCCH's own Allow All (`#allowAll`) is the session-wide answer.
- On deny, OMP reports the tool as failed, and `reply.message` cannot be passed through. The UI copy says "denied".
- The **Allow All** and in-memory `#allowAll` behaviour in `AgentTurnReactor` (`apps/server/src/agent.ts`) work unchanged, because OMP prompts flow through `#cliPrompts` like Claude's.
- A `timeout` on the request is enforced by the host, which answers `cancelled: true, timedOut: true`.
- The fallback planned for "OMP cannot ask" is not needed: it asks (OM0).

### 3.6 Turn lifecycle
1. `OmpRpc.start(...)` → `ready` → `negotiate_protocol`.
2. `set_subagent_subscription { level: "progress" }`.
3. `set_host_tools { tools }` (§3.7).
4. If resuming without `--resume`: `switch_session`.
5. `prompt { message }`, where the message is the user's text plus research or documentation additions, exactly as built today for CLI turns (`agent.ts`, the `context.injected` `research` / `documentation` events).
6. Stream until `agent_end`, terminal, and `prompt_result`. Then `get_session_stats`, emit `agent.turn_completed` with the difference from a `get_session_stats` taken before the prompt (the totals are the session's, and a resumed session has some), and `close()`.

`get_state` is asked after step 1, and its `sessionId` is `agent.session_started`. Steps 3 (host tools) and 4 are not taken: host tools are OM3.2, and resuming uses `--resume` (§3.1).

**Signals:**
- `interrupt()` answers every open approval with `cancelled: true` (OMP does not answer `abort` while a dialog is open; OM2.4), sends `abort`, waits for the terminal `agent_end` and `prompt_result { status: "aborted" }`, then `close()`. That is "end the turn cleanly" in `AgentRun` terms. If the process is still there after 10 s, `kill()`.
- `kill()` is `OmpRpc.kill()`.
- **Steering mid-turn.** A second `thread.send` while a turn runs can be forwarded as `steer` instead of queued. This is optional and comes after OM2, behind a composer affordance. Today's queueing (`agent.queued`) stays the default.

**One process per turn, not one per thread.** The cost is startup time, measured in OM0; it is expected to be under 1 s. The gain is no idle processes holding RAM, which matches the CLI providers. A warm pool is a later optimisation (§13).

### 3.7 Host tools: keeping UCCH's own tools
`set_host_tools { tools: [...] }` advertises host functions. OMP then sends `host_tool_call`, the host may send `host_tool_update`, and must finish with `host_tool_result` (with `isError` on failure). `host_tool_cancel { targetId }` aborts ([rpc](https://omp.sh/docs/rpc)).

UCCH advertises tools from the existing `@ucch/agent` registry (`packages/agent/src/registry.ts`), reusing `toolByName` and `buildSchemas`:

| Host tool | From | Why OMP lacks it |
|---|---|---|
| `ucch_document_*` (render, convert) | `tools/documents` | LibreOffice/mermaid pipeline, the render gate |
| `ucch_upload_read`, `attach_upload` | `tools/uploads` | UCCH upload store |
| `research_search`, `research_read`, `research_browse` | `tools/research` | Crawl4AI and Browser Use with UCCH's keys |
| `current_time` | `tools/system` | trivial, for parity |

- OMP's own `read`, `write`, `edit`, `glob`, `grep`, `bash` and `web_search` replace `fs`, `search`, `shell` and `web`.
- `web_search` needs a search key. Where none is configured, `research_search` is the fallback, and the overlay sets `tools.approval.web_search: deny` if no key exists.
- **Execution.** `runTool` from `packages/agent/src/loop.ts` is factored out to `packages/agent/src/run-tool.ts`, so the host-tool runner and the fallback loop share it. The `Executor` (`executor.ts`, `executors/host.ts`, `confine.ts`) keeps confinement exactly as it is for native turns.
- **Presets.**
  - The `research` preset becomes "OMP with research host tools and `tools.approval.write/edit: deny`".
  - The `documentation` preset becomes "OMP with the documentation host tools and only `write`/`edit` allowed under `docs/`". The path check is done by the guard hook (§3.9).
  - These replace `selectPreset` for OMP turns.
- **Schema format: JSON Schema** (OM0): `{ name, label, description, parameters }`, answered `{ toolNames }`.
- **How the model sees them (OM0).** With the default `tools.xdev: true`, host tools are mounted as `xd://<name>` devices, listed in the system prompt, and called by `write`-ing JSON arguments to that path. `host_tool_call { id, toolCallId, toolName, arguments }` names the host tool either way. A device call is tier `exec`, so the overlay's `tools.approval` must name every host tool (`allow`), or `write` mode asks for each.
- **Subagents do not see host tools** (OM0): a worker's tools are its agent definition's. The `research_*` host tools stay with the parent turn.

### 3.8 Knowledge and the system prompt
- `instructions` (the `.ucch/` knowledge from `renderKnowledge`) goes through `--append-system-prompt`, alongside a short UCCH section:
  - the worktree path;
  - that the chat is the way to ask questions;
  - the commit policy: never commit or push, because the Git view does.
- OMP also reads `AGENTS.md` from the worktree itself ([context files](https://omp.sh/docs/context-files)); `.claude/CLAUDE.md` only through its `claude` source, which the overlay disables (OM6.8, measured in OM7.6). The native loop's own AGENTS.md injection is not repeated, to avoid doubles.

### 3.9 The UCCH guard hook
`packages/providers/assets/omp-hooks/ucch-guard.ts` is copied into `<subject>/omp/agent/ucch-guard.ts` by `ensureCredsDir("omp")` and loaded with `--hook <abs path>`. OM0: a user-scope hook in `agent/hooks/pre/` does **not** load under `--no-extensions`; `--hook` does, under every flag set. The hook sees `{ toolName, input }` (`input.command` for `bash`; for a device call, `toolName: "write"` with `input.path: "xd://<tool>"` and the JSON in `input.content`), and `{ block: true, reason }` ends the call with that reason as its error.

The hook's `tool_call` handler blocks:
- `git push` (any), `git commit` (the Git view owns commits), `git reset --hard` outside the worktree, and `--force` pushes;
- writes and edits whose path resolves outside the worktree, or outside `docs/` in the documentation preset;
- `printenv`, `env`, and `cat /proc/*/environ`;
- a `task` call naming an agent that is not bundled (`scout`, `reviewer`, `security-reviewer`, `sonic`, `task`, `seance`). Under `--no-extensions` OMP already refuses those (§0.3); the hook keeps that true if a later version changes it.

A `tool_call` exception or timeout "fails closed" ([hooks](https://omp.sh/docs/hooks)), so a broken hook blocks rather than allows.

---

## §4 The UCCH overlay (`ucch-omp.yml`)

Written per run to `<subject>/omp/run/<turnId>.yml` (mode 0600), passed with `--config`, and deleted after the turn. Overlays rank above project config and below runtime flags ([settings](https://omp.sh/docs/settings)). Mappings deep-merge, but **arrays replace**, so the overlay always writes whole arrays.

```yaml
# Context management — /docs/compaction, /docs/handoff
compaction:
  enabled: true
  methodOrder: [handoff, remote, shake, soft]   # handoff first = automatic handoff; snapcompact dropped (needs vision, opaque to UCCH's log)
  keepRecentTokens: 20000
  midTurnEnabled: true
  asyncEnabled: true
  autoContinue: true
  idleEnabled: false        # one process per turn: never idle
  handoffSaveToDisk: true   # handoff-*.md next to the session, linked from the thread (default false)
  supersedeReads: true
  dropUseless: true

# Memory — /docs/memory
memory:
  backend: mnemopi          # or "off" per workspace
mnemopi:
  scoping: global           # OM0: per-project keys the bank on the cwd, so each thread worktree got its own
  dbPath: <CREDS_ROOT>/<subject>/omp/memories/<projectId>/mnemopi.db   # one bank per UCCH project (§7.1)
  autoRecall: true
  autoRetain: true
  retainEveryNTurns: 4
  recallLimit: 8
  llmMode: smol             # workspace setting: smol | none
  noEmbeddings: true        # OM7.1: embeddings fetch ~770 MB into HOME on first use; recall is full-text (smol helps)

# Subagents — /docs/subagents
task:
  maxConcurrency: 4         # OMP_WORKERS_PER_TURN; docs default 32 is far too many for 8 GB
  maxRecursionDepth: 1
  softRequestBudget: 120
  maxRuntimeMs: 900000      # 15 min per worker
  agentIdleTtlMs: 60000     # park quickly; the process ends with the turn anyway
  isolation:
    enabled: false          # workers share the thread's worktree (already isolated per thread); true only for fan-out edit tasks, OM5.5, where each task sets `isolated: true`
    apply: true
    merge: patch
async:
  enabled: true

# Roles — /docs/agents-and-roles (values from workspace settings; OpenRouter ids)
# modelRoles is a record, so EVERY role is named, or a project could point
# one at any model on the workspace's key (OM2.5: a project modelRoles.default
# is honoured). The binary's roles are default, smol, slow, plan, vision,
# commit, plus advisor; there is no task or tiny role (tiny is a local-model
# kind; mnemopi's tiny lookup falls back to smol).
modelRoles:
  default: openrouter/<workspace default>
  smol: openrouter/<workspace fast model>
  slow: openrouter/<workspace deep model>
  plan: openrouter/<workspace deep model>
  vision: openrouter/<workspace default>
  commit: openrouter/<workspace fast model>
  advisor: openrouter/<workspace deep model>
retry:
  modelFallback: false      # else a project's retry.fallbackChains picks the model
contextPromotion:
  enabled: false            # else overflow switches to a bigger model
providers:
  cacheWarming: idle        # OMP's default, named so a project cannot pick "streaming"

# Code intelligence / edits / debug — /docs/code-intelligence, /docs/editing, /docs/debugging
lsp:
  enabled: true
  lazy: true
  shared: true
  formatOnWrite: false      # never reformat a user's repo unasked
  diagnosticsOnWrite: true
  diagnosticsDeduplicate: true
astEdit:
  enabled: true
debug:
  enabled: true             # false for untrusted projects: project dap.json loads under every flag (§0.3)

# Approvals — /docs/approvals
# tools.approval is a record, and records merge with project .omp/config.yml
# (OM0), so the writer names EVERY tool, per permission mode: prompt for what
# the mode asks for, allow for what it runs, deny for what is off. A tool the
# overlay leaves out can be set to allow by a cloned repository.
# The list (OMP_TOOL_TIERS in omp-overlay.ts) is the binary's own tool list
# (fixtures/omp-tools.txt) plus the xd:// devices, each with its tier from
# /docs/tools; mixed tiers take the highest, undocumented ones are exec.
# Devices must be named too: an xd:// write checks the device's own policy,
# then falls back to `write` (OM2.5: `write: allow` alone ran a host tool
# unasked under --approval-mode write).
# Per mode: read → allow; write → prompt under strict, else allow;
# exec → prompt, allow under allow_all.
tools:
  approval:
    bash: prompt            # exec
    edit: allow             # write
    read: allow             # read
    # … every tool and device of the pinned version, and each host tool
    debug: deny             # untrusted projects; exec tier when trusted
    web_search: deny        # without a search key
    browser: deny           # workspace setting may lift
    ask: deny               # questions go to the chat
    github: deny            # UCCH's Git view owns remotes
    computer: deny
    generate_image: deny
    tts: deny
    hub: deny               # collaboration with other OMP processes
    report_issue: deny      # tool QA; can report to qa.omp.sh

# Tools and features switched off, or by the workspace (records aside, a
# project can flip any of these on, so each is named)
ask: { enabled: false }
github: { enabled: false }
browser: { enabled: false } # workspace toggle; an eval prelude in 18.14.1
computer: { enabled: false }
generate_image: { enabled: false }
speechgen: { enabled: false }
speech: { enabled: false }
web_search: { enabled: <search key configured> }
autolearn: { enabled: false }
recap: { enabled: false }
dev: { autoqa: false }
telemetry: { otlpExportEnabled: false }   # traces to any OTEL_* endpoint otherwise

# Plan / prewalk / advisor — /docs/plan, /docs/prewalk, /docs/advisor
plan:
  enabled: true
prewalk:
  enabled: false            # workspace "economy" toggle
advisor:
  enabled: false            # workspace toggle; billed separately

# Project sources off (§0.3; key paths from OM0) — /docs/skills, /docs/mcp
skills:
  enableClaudeProject: false
  enablePiProject: false
  enableAgentsProject: false
commands:
  enableClaudeProject: false
  enableOpencodeProject: false
mcp:
  enableProjectConfig: false

# Nor any other agent's configuration (OM6.8): OMP reads Claude Code's
# skills, rules and MCP servers whenever CLAUDE_CONFIG_DIR is set.
disabledProviders: [claude, claude-plugins, codex, cursor, gemini, opencode, windsurf, github]
```

- **Workspace overrides.** `workspace-harness-settings.tsx` stores the workspace values: models per role, memory on or off, `llmMode`, economy, advisor, browser. The overlay writer (`apps/server/src/omp-overlay.ts`) merges them in.
- **Unit tests.** One snapshot per preset and permission mode, plus a test that every key appears in `omp config list --json` for the pinned version (an OM0 fixture, `fixtures/omp-config-list.json`), and one that `tools.approval` names every tool in `fixtures/omp-tools.txt`. A setting renamed or a tool added upstream then fails CI, instead of being silently ignored.
- **Presets.** `research` denies `write`, `edit`, `ast_edit`, `learn`, `manage_skill`; `documentation` keeps writes and leaves the `docs/` rule to the guard hook (§3.9). Memory (`memory.backend: mnemopi` and the `mnemopi` block) is written only when the workspace turns it on (OM7.1); until then `memory.backend: off`.

---

## §5 Context management and handoff

### 5.1 Compaction on OMP threads
- Automatic, per the overlay.
- `auto_compaction_end` becomes `context.injected { source: "compaction" }`. `session-log.ts` `rebuild()` already treats that as a checkpoint, so the fallback loop could rebuild from it.
- The chat shows a divider: "Context compacted (handoff) · 142k → 31k tokens". It is a collapsible block, using the `context.injected` rendering that already exists for research briefs.

### 5.2 Context meter
`context-meter.tsx` and `lib/context-window.ts` currently estimate from usage. For OMP turns, the reactor calls `get_session_stats` after each `turn_end` and publishes `context.usage` (a new transient event, §App. B). The fields are `{ usedTokens, windowTokens, thresholdTokens }`: `usedTokens ← contextUsage.tokens` and `windowTokens ← contextUsage.contextWindow` from `get_session_stats` (OM0). The stats carry no threshold, so `thresholdTokens` comes from the overlay UCCH wrote (`compaction.thresholdTokens`, or `thresholdPercent` × the window), and is null when neither is set.

### 5.3 Manual actions (OMP threads)
Two new commands in `packages/protocol/src/commands.ts`:
- `thread.compact { threadId, focus? }`
- `thread.handoff { threadId, focus? }`

`decide()` accepts them only when the thread is bound to `omp` and idle. The reactor starts a short OMP process on the thread's session and sends `compact { customInstructions: focus }` or `handoff { customInstructions: focus }`, then emits the resulting `context.injected`. The UI puts them in the thread menu as **Compact** and **Hand off…**.

As built (OM4.3): the accepted command emits `thread.compaction_requested { threadId, method, focus? }`, which claims the thread as `running` (so Stop reaches the process), and every way out ends with `thread.compaction_finished { threadId, method, error? }`, which frees it. No turn opens; the divider is a `context.injected` with no `turnId`, drawn under the last answer, followed by a `context.usage` with no `turnId`. OMP answers `handoff` with `{}`, so both read the new summary back from `get_messages`. The chat has no thread menu; the actions are the composer's `/compact` and `/handoff` commands, each taking what to keep as free text.

### 5.4 Cross-provider handoff (any provider → any provider)

**Command:** `thread.handoff_to { threadId, targetProvider, focus? }`.

**Flow:**
1. `decide()` checks that the source thread is idle. It emits `thread.handoff_requested`.
2. **The reactor builds the brief.**
   - It renders the source thread's transcript from the event log as plain text: user messages, assistant text, tool calls with truncated results, and the files changed according to `file.changed` / the checkpoints.
   - It runs a one-shot OMP call: `omp -p --no-session --no-tools --model @smol --config <overlay>`, with a turn's guard flags (`--no-extensions --no-rules --no-lsp --hook`). The transcript goes on stdin and the instruction is the prompt argument (measured: spike report, "Measured later").
   - The prompt is a fixed instruction modelled on OMP's handoff contents ("the work completed so far, the decisions that matter, and the next steps", [handoff](https://omp.sh/docs/handoff)), with `focus` appended.
   - `--no-tools` because the brief is built from the transcript alone.
3. A new thread is created on `targetProvider` in **the same worktree** (`thread.create` with `worktreeOf: sourceThreadId`, plus a new optional field). Its first `user.message` is the brief inside `<handoff-brief>`, followed by "Continue from here."
4. The events `thread.handed_off { from, to, brief }` link the two threads. The UI shows "Continued in →" and "Continued from ←".

**As built (OM4.5):**
- **Claim.** `decide()` takes a thread that has run (`provider` set) and is `idle` or `error`. A turn that failed on a usage limit leaves `error`, and that is what OM4.6 hands off. Its worktree must be ready. `thread.handoff_requested` claims it as `running`, so `thread.cancel` stops the brief. It needs `session.create` and `project.write`.
- **Brief.** `AgentTurnReactor` reads `store.threadHistory`, takes an OMP slot, and asks on an overlay whose roles all resolve to `SEARCH_MODEL`, the server's compaction model, so `@smol` is never the coding model. The account's OpenRouter key pays for the brief, whichever providers sit on either side.
- **New thread.** It is dispatched as the person who asked:
  - `thread.create { worktreeOf, title: "Continued: <title>" }`, keeping the source's credential source.
  - Then `thread.handed_off`, appended to the new thread, so its log opens with where it came from.
  - Then `thread.send { provider: targetProvider }`.
  - Finally `thread.handed_off` on the source, which frees it. Any failure ends with `thread.handoff_failed { error }` instead.
- **Same folder.**
  - `thread.created` gains `worktreeOf` and `treeHash`, the hash of the thread whose worktree it is: the first one, down a chain of handoffs. The new row is `ready` at once, on the same branch. `WorktreeReactor` skips it.
  - Two columns: `threads.tree_hash` (a hash, not an id, so the folder stays named once the thread that made it is gone) and `threads.handoff_from_thread_id`.
  - `treeFor` and the `?session=` / collab lookups resolve through it. Each matches `hash = h OR tree_hash = h`.
  - The web addresses a session's tree by `treeHash ?? hash` (`project-workspace.tsx`). That is also the `worktreeId` the shared folder's file events carry, so both threads hear them.
- **Removing.** `SessionLifecycle` counts the other sessions in a folder. A session removed while another shares its worktree takes only its row; the last one out takes the worktree and the branch. No session settles while another is working in its tree.
- **Stream.** `thread.create` with `worktreeOf` loads the source as the command's thread. The engine appends `thread.created` to the new thread's stream, not the source's.
- **UI.**
  - `/continue <harness>` in the composer starts it. It is offered once the thread has run, whoever sent its turns.
  - "Writing a brief … for <harness>…" shows while it runs.
  - The new thread's first message shows the brief folded under "Handoff brief", and the request ("Continue from here.") as the message.

**Automatic triggers** (workspace setting, off by default):
- **Usage limit.** A CLI turn fails with a usage-limit or quota error. Classified in the normalisers: Claude's `rate_limit_event` / `error_*` result, Codex's error item. The trigger applies when the workspace has a fallback provider set.
- **Context full.** Claude Code's reported context usage (`mapUsage`) passes 90% of the window. The next turn on that thread offers "Hand off" in the composer. It is not automatic, because Claude Code compacts on its own.
- These interact with the "auto queueing" idea in `idea.md`. The handoff target can be "the same provider, after reset", which is just the existing queue.

**As built (OM4.6):**
- **Setting.** `workspaces.agent_settings` (jsonb, migration 0029) holds `WorkspaceAgentSettings` (`packages/protocol/src/agent-settings.ts`), one zod section per toggle; `autoHandoff { enabled, fallbackProvider }` is the first. A section that does not parse reads as its defaults. It is set through the workspace settings route (`agent`, beside `credentialPolicy`), needs `credentials.manage`, and is audited as `workspace.agent_settings`. Later sections (memory, bridge, isolation, verify) join the same column without a migration.
- **Classification.** `agent.turn_failed` gains `limit: true`. Claude Code 2.1.316: a `rate_limit_event` with `status: "rejected"`, an assistant or result line with `api_error: "usage_limit_reached"` (or `error: "billing_error"`), or the CLI's "You've hit your … limit" wording. Codex 0.166.0: its error item's wording ("You've hit your usage limit", with a U+2019 apostrophe; quota, credits, spend cap); its `error` then `turn.failed` for the same failure fail the turn once. The Claude fixture is recorded; the Codex one is constructed from the binary's strings, since running the downloaded binary was not allowed here.
- **Trigger.** `AgentTurnReactor` dispatches `thread.handoff_to { reason: "limit", message }` with the failed message, which the new thread gets in place of "Continue from here.". Once per chain: a thread whose history already holds a `thread.handed_off` with `reason: "limit"` is not handed off again, so a second limit does not loop.

**Why not `omp --from-claude`?** The import is an interactive picker ([sessions](https://omp.sh/docs/sessions)), and UCCH's event log is already provider-neutral. OM0: there is no non-interactive import (`--from-claude is not supported in rpc mode`; in `-p` it draws the picker and exits), so every target gets the brief.

---

## §6 Subagents

### 6.1 Protocol additions (`packages/protocol/src/events.ts`)

```ts
const AgentSubagentStarted = z.object({
  type: z.literal("agent.subagent_started"),
  threadId: z.string().uuid(), turnId: z.string().uuid(),
  subagentId: z.string().min(1),
  parentToolUseId: z.string().nullable(),   // the task/Task call that spawned it
  agent: z.string(),                        // "scout", "reviewer", "Explore", …
  description: z.string().nullable(),
  model: z.string().nullable(),
});
const AgentSubagentProgress = z.object({    // transient, like agent.text_delta
  type: z.literal("agent.subagent_progress"),
  threadId: z.string().uuid(), turnId: z.string().uuid(),
  subagentId: z.string(), summary: z.string(), toolCalls: z.number().int().nonnegative().optional(),
});
const AgentSubagentFinished = z.object({
  type: z.literal("agent.subagent_finished"),
  threadId: z.string().uuid(), turnId: z.string().uuid(),
  subagentId: z.string(),
  status: z.enum(["completed", "failed", "aborted"]),
  result: z.string().nullable(),            // truncated
  usage: TokenUsage.optional(),
  costUsd: z.number().nonnegative().optional(),
});
```

`agent.subagent_progress` joins the transient list next to `agent.text_delta` (`events.ts:861`).

As built (OM5.1): progress also carries `model?`, `durationMs?` and `costUsd?`, and `finished` carries `toolCalls?` and `durationMs?`, since every source reports them. Subagents still running when the turn ends finish as `aborted` (or `failed` on a crash).

### 6.2 Sources
- **OMP:** `subagent_lifecycle` and `subagent_progress` frames after `set_subagent_subscription progress` (OM0, `omp-subagent.jsonl`):
  - `subagent_lifecycle { payload: { id, agent, parentToolCallId, status: "started"|"completed"|…, sessionFile, index } }` starts and finishes a subagent; `subagentId` is `payload.id`, `parentToolUseId` is `payload.parentToolCallId`;
  - `subagent_progress { payload: { id?, agent, task, parentToolCallId, progress: { status, recentTools, recentOutput, toolCount, tokens, cost, durationMs, resolvedModel, … } } }` is the progress row;
  - the result text arrives as a `custom` message with `customType: "async-result"` after the worker ends, because tasks are background jobs: the parent's first `agent_end` has `isTerminal: false`.
- **Claude Code:** `ClaudeNormaliser` (`claude.ts:353`) stops dropping lines that carry `parent_tool_use_id`:
  - the first such line for a `Task` tool use emits `agent.subagent_started`, with `subagentId` set to `parent_tool_use_id` and `agent` set to the Task input's `subagent_type`;
  - assistant text and tool calls inside it become `agent.subagent_progress`, rate-limited to one event per second;
  - the Task `tool_result` emits `agent.subagent_finished`.
  - The subagent's prose still never becomes the turn's prose, which keeps the invariant the comment states.
  - **As built (OM5.2, 2.1.316):** the tool is `Agent` (`Task` is still matched) and runs in the background: its `tool_result` is only "Async agent launched…". `system` lines `task_started { task_id, tool_use_id, description, subagent_type, is_backgrounded }`, `task_progress { usage: { tool_uses, duration_ms }, summary?, last_tool_name }` and `task_notification { status: completed|failed|stopped, summary, usage }` carry it; `subagentId` is the call's `tool_use_id`. `task_notification` finishes it (`stopped` → `aborted`), with the subagent's last text as the result. A foreground subagent finishes from its call's result. Its tool calls stay the turn's `agent.tool_use` / `agent.tool_result`.
- **Codex:** no subagent stream today, so nothing is emitted.
- **Bridge:** an `omp_task` call is an MCP tool call to the CLI. The bridge can additionally report progress through MCP progress notifications, which the CLI may or may not surface. No UCCH events come from the bridge directly; it has no channel back to the server.

### 6.3 UI
In `project-chat.tsx`'s tool rows, a `task` / `Task` / `mcp__omp__omp_task` call renders as a **subagent card**:
- the agent name, model, live summary, tool-call count, duration and cost;
- expanding it shows the result.

It follows the `apps/web/CLAUDE.md` rules: a skeleton, not a spinner.

### 6.4 UCCH roles (no agent files)
OM0 found that custom agents, user scope as well as project scope, are **not runnable under `--no-extensions`** (`Unknown agent "…". Available: scout, reviewer, security-reviewer, seance, task, sonic`), and that `PI_CODING_AGENT_DIR` does not move the `agents/` directory. UCCH runs `--no-extensions` always (§0.3), so it ships no `ucch-*` agent files. Its roles are the bundled agents:
- **Verifier** (§9.4): the bundled `task` agent, with the role's instructions in the `task` call's `context` ("Verify the assigned task against its acceptance criteria. Run the project's tests if the task names them. Cite file and line for every finding. Do not edit files.") and a reply format in `task`: a final fenced JSON block `{ "passed": boolean, "reason": string, "findings": [{ "file", "line", "note" }] }`. UCCH parses that block with zod; on a parse failure, `parseVerdict`'s regex is the fallback.
- **Researcher:** `scout` with OMP's own `web_search`, since workers cannot see host tools (§3.7).
- **Reviewer:** the bundled `reviewer`, whose `output` is already structured (§9.2).

The role prompts live in `packages/providers/src/omp-roles.ts`, next to the code that parses their replies.

### 6.5 Caps and isolation
- Per turn: `task.maxConcurrency: 4` and `maxRecursionDepth: 1`.
- Per server: the `TurnScheduler` counts **OMP processes**, which is one per OMP turn plus one per bridge call. Workers inside a process are not separate OS processes (OM0: four scouts ran in the one `omp` process, adding ~45 MB).
- **Isolation.** `none` by default, because each UCCH thread already has its own worktree (`thread.worktree_ready`). For fan-out edit tasks (OM5.5), `task.isolation.enabled: true` (and `isolated: true` per task) with `merge: patch`, so each worker's patch is applied back to the thread's worktree. Conflicts surface as a failed worker with patch metadata ([subagents](https://omp.sh/docs/subagents)).
- **As built (OM5.5).** The workspace's `agent_settings.isolatedFanOut` turns it on. OMP does not fail a worker whose patch did not apply: it reports `completed`, and only its `<merge-summary>` says "Patches were not applied". `OmpNormaliser` makes that `agent.subagent_finished { status: "failed" }` with the reason, leaving out OMP's path to the patch.

---

## §7 Memory

### 7.1 Store
- `memory.backend: mnemopi`, `mnemopi.scoping: global` and `mnemopi.dbPath: <subject>/omp/memories/<projectId>/mnemopi.db` ([memory](https://omp.sh/docs/memory)).
- The subject is the workspace for shared workspaces and the user for personal ones, the same rule as the credential directories, so a workspace's members share a bank.
- **Workspace setting** (OM7.1). `memory { enabled, llmMode }` in `workspaces.agent_settings`, off by default, set in the "Project memory" card of the harness settings. With it on, an OMP turn's overlay names `ProviderService.ompMemoryDb(subject, projectId)`, made 0700 on first use.
- **No embeddings** (OM7.1, measured). With `noEmbeddings: false`, the first memory turn downloaded a `bge-base-en-v1.5` ONNX model (209 MB), an onnxruntime package (328 MB) and 233 MB of npm packages into the server user's HOME. So the overlay sets `noEmbeddings: true`. Recall is then full-text: a fact about "Fly.io region ams" was recalled for "Which Fly.io region do deploys go to?" but not for "Work on the deploy.".
- **Why not `per-project`** (OM0): it names the bank `<basename(cwd)>-<hash(cwd)>`, so two thread worktrees of one project got two banks. A global bank in a file chosen per project gives one bank per UCCH project, across its worktrees, with no symlink or stable `--cwd`.

### 7.2 Relationship to `.ucch/`

| | `.ucch/` knowledge | mnemopi |
|---|---|---|
| Written by | people (and agents on request) | automatic retention plus `retain` |
| Lives | in the repo, versioned | in the subject's OMP directory, private |
| Reaches the model | `--append-system-prompt` (every provider) | `autoRecall` on OMP turns; `omp_recall` for CLIs |
| Wins on conflict | yes, because it is the current repository state | no: "If it conflicts with the current prompt or repository state, the current information wins" |

### 7.3 Claude Code and Codex
- **Bridge tools.**
  - `omp_recall(query)` runs one `omp --mode rpc --no-session --tools recall --model @smol` call (§10.2; there is no `tiny` role, OM6.2) and returns the recalled facts.
  - `omp_retain(fact, kind)` runs the same command with the `retain` tool.
  - The model call goes through `mnemopi.llmMode: smol`. With `llmMode: none`, recall is full-text search only.
- **End-of-turn retention** (workspace toggle, off by default). After a CLI turn completes, the reactor runs `omp_retain` with the turn's final assistant message, never tool output (§0.2).
- **As built (OM7.2).**
  - The bridge gets memory as the workspace has it: the bridge overlay names the project's bank, and the env carries `UCCH_OMP_MEMORY=1`. This holds for turns and for terminals.
  - Retention is `memory.retainCliTurns`. It is not a bridge call: the reactor runs `OmpProvider.ask` (`omp -p --no-session --tools retain`, `@smol`) on an OMP slot of its own after the turn, with the text of the last `agent.message` on stdin (`omp-memory.ts`), cut at 16 000 characters. The prompt asks for at most five durable facts with project scope, and no secrets or task state.
  - The bridge and retention overlays set `autoRecall: false` and `autoRetain: false` (`memoryToolsOnly`). With `autoRetain` on, mnemopi stored the retention run's whole prompt and stdin as a memory, verbatim, next to the fact the model kept. A bridge call would likewise store its assignment. Only OMP turns recall and retain on their own.
- **Settings UI.** A memory card with `/memory stats` and `/memory clear` equivalents. OM0: slash commands do not run in `-p` (the model received the literal `/memory stats`; only prompt templates such as `/review` expand), so the card reads the project's `mnemopi.db` (SQLite) directly, and clear deletes that file.
  - **As built (OM7.3).** An "OMP memory" card in `provider-settings.tsx`, with a project picker. It reads the bank of the subject the cards pay for: yours, or with `?workspace=` the workspace's.
  - `GET /api/omp-memory/:projectId` (`omp-memory-routes.ts`) counts `working_memory` rows by `memory_type` (`fact` and `episode`) plus `episodic_memory`, through `node:sqlite` read-only. It returns only counts, size and the newest timestamp.
  - `DELETE` removes the file with its `-wal`, `-shm` and `-journal` companions. It needs `credentials.manage` for a workspace's bank, and the action is audited.
  - The project must be one the caller can see, and a workspace's bank serves only that workspace's projects.

---

## §8 Structural edits, code intelligence, debugging

### 8.1 Structural edits ([editing](https://omp.sh/docs/editing))
- **OMP threads.** `astEdit.enabled: true`. Turn `ast_grep` on with the tools setting.
- **Bridge** (§10): `omp_codemod`.
- **`PI_MAX_AST_FILES`** stays at its default of 1,000. The docs advise narrowing scope instead.
- **Change tracking.** Changes made by `ast_edit` are ordinary file writes, so UCCH's file watcher and checkpointing (`checkpoint.captured`, `file.changed`) see them like any other edit.

### 8.2 Code intelligence ([code intelligence](https://omp.sh/docs/code-intelligence))
- **Image.** `typescript-language-server` + `typescript` and `pyright` go on `PATH`; others are added by request. "Project-local executables take precedence", so a repo's own `node_modules/.bin/typescript-language-server` would be used. Untrusted projects run `--no-lsp` (§0.3).
- **Launch.** OMP launches at the **worktree root**. Monorepo packages: root markers are checked only in the launch directory, so the bridge's `omp_symbols` takes an optional `packageDir` and launches there.
- **Cost (OM0).** A TypeScript server on this repository is ~725 MB RSS (6 processes, all children of `omp`), and it is gone ~3 s after `omp` exits, even with `lsp.shared: true`. With one process per turn, sharing helps only turns running at the same time, so every LSP turn pays the cold start and the memory. The scheduler counts an LSP turn as more than one slot (§13, OM7.4). `PI_DISABLE_LSPMUX` is the escape hatch for the broker.
- **Diagnostics.** `lsp.diagnosticsOnWrite: true`. Diagnostics come back to the model in the tool result, and the UI shows them inside that result. OM7.4 measured that a write usually returns before the language server answers. The diagnostics then reach the model as a later `<system-notice>` ("Late LSP diagnostics arrived after the edit returned: …"), not inside the `write` result.
- **As built (OM7.4).** The image installs `typescript-language-server` 6.0.2, `typescript` 5.9.3 and `pyright` 1.1.414 globally (`ARG OMP_LSP_*`). TypeScript stays on 5.x because 7.x is the native compiler, with no `tsserver`. They start only for a trusted project (`ompArgv` adds `--no-lsp` otherwise), and every turn is untrusted until OM7.6. Measured in the image on a trusted turn: an `lsp` rename edited `a.ts` and three uses in `b.ts`, and TypeScript and Pyright errors in written files came back as late diagnostics. Peak RSS was 408 MB for typescript-language-server with its two `tsserver`s, 128 MB for pyright, and 400 MB for `omp` itself. None were left 4 s after `omp` exited. Counting an LSP turn as more than one slot waits for OM7.6, the first time such a turn exists.

### 8.3 Debugging ([debugging](https://omp.sh/docs/debugging))
- **Image.** `debugpy` (pip) and js-debug: the vscode-js-debug DAP server, with `JS_DEBUG_DAP_SERVER` pointing at it. "This is a server from vscode-js-debug, not an npm package."
- **Config.** A user-scope `dap.json`, for trusted projects. OM7.5: OMP reads it from `$HOME/.omp/agent/`, not from `<subject>/omp/agent/`, so it is the image's (below). Project `.omp/dap.json` and root `dap.json` load under every flag (OM0), so untrusted projects get `debug.enabled: false` and no debugger at all.
- **Attach.** Allowed for processes inside the container. The guard hook refuses PIDs outside the thread's process tree. OM0: the hook sees the call as `toolName: "write"`, `input.path: "xd://debug"`, with `{ "action": "attach", "pid": … }` in `input.content`.
- **As built (OM7.5).** The image installs debugpy 1.8.22 in its own venv, `/opt/debugpy`, and the js-debug DAP server 1.140.0 from its release tarball (SHA-256 checked) in `/opt/js-debug`, with `JS_DEBUG_DAP_SERVER` naming `dapDebugServer.js` (`ARG OMP_DAP_*`, 43.6 MB). OMP's built-in `debugpy` adapter runs `python -m debugpy.adapter`, and the image has no `python`, so a user-scope `dap.json` moves its `command` to the venv's Python. An override merges into the built-in, so its arguments and launch defaults stay OMP's.
  - **Not `<subject>/omp/agent/dap.json`.** OMP 18.14.1 reads user-scope `dap.json` from `$HOME/.omp/agent/` and `$HOME/` only, never from `PI_CODING_AGENT_DIR` (measured, as for `agents/` in §6.4). The file is therefore baked into the image at `/home/node/.omp/agent/dap.json`, the server's `HOME` (`deploy/s6/s6-rc.d/server/run`). It names no secret and is the same for every subject. A project's own `dap.json` still outranks it, and loads only for a trusted project.
  - **Measured** in the built image, on an OMP turn built by the server's own `ensureCredsDir`, `writeOmpOverlay` and `ompArgv` (trusted, scripted model, `HOME=/home/node`). js-debug launched `app.js`, a breakpoint on line 5 was verified and hit, and `scopes` then `variables` gave `sum = 15`, `avg = 5`, `items = [3, 4, 8]`. debugpy did the same for `app.py`: `total = 15`, `count = 3`, `avg = 5.0`. Without the file, debugpy fails at launch with "python not found in PATH".

---

## §9 Code review ([review](https://omp.sh/docs/review))

### 9.1 Engine
- **Command.** `omp -p "/review <mode> <focus>" --mode json --no-session --config <overlay> --model @slow`, run in the thread's worktree. OM6.2: under `--no-extensions`, which every UCCH run keeps, `/review` is not expanded and reaches the model as text, so the engine sends the headless review request `/review` expands to, as `omp_review` does.
- **Modes.**
  - The Git view's **Review changes** runs uncommitted changes.
  - **Review branch** runs against the base branch, using the project's default branch.
  - A commit row's **Review** runs on that commit.
- **PR mode** (`/review <PR URL>`) needs `gh` authenticated. It comes later and depends on the GitHub integration.
- **Exclusions.** OMP already skips lock files, generated code, `dist/` and vendored code, and reports what it excluded. The UI shows that list.

### 9.2 Output
- OM0: `--mode json` is the ordinary event stream, with no findings frame, and without `--wait-async` the process exits before the reviewer runs. The bundled `reviewer` agent, which `/review` dispatches, has a structured `output`: `overall_correctness: "correct"|"incorrect"`, `explanation`, `confidence`, `findings[] { title, body, priority (0–3), confidence, file_path, line_start, line_end }`.
- So UCCH runs `/review …` in RPC mode, waits for the terminal `agent_end`, and parses the reviewer's structured result with zod: `ReviewFinding { priority: P0..P3, confidence: 0..1, title, body, file, startLine, endLine }` plus `ReviewVerdict { verdict, explanation, confidence }`. Where that result lands in the frames is recorded with a real model in OM7.7 (a scripted model cannot make the reviewer's `yield` calls).
- **Persistence.** Results are a new `review.completed { projectId, threadId?, scope, findings, verdict, model, costUsd }` event (§App. B).

### 9.3 UI (`apps/web/src/components/git/*`)
- Findings render inline on the diff at their line ranges, with a priority badge and a confidence bar. The docs say "Confidence is not severity", so the two are shown separately.
- The verdict is a banner. A **Send to agent** button posts the selected findings to the thread as a message.

### 9.4 Task pipeline
`apps/server/src/task-pipeline.ts`'s verify step (`verifyPrompt` / `parseVerdict`, lines 160–161 and 307–324) can use the OMP verifier role (§6.4) for any coding provider. It is a workspace setting, "Verify with OMP". The structured `{ passed, reason, findings }` replaces the regex in `parseVerdict`, which stays for the fallback.

---

## §10 `omp-bridge`: OMP tools for Claude Code and Codex

### 10.1 Package
- `packages/omp-bridge` is a Node 22 MCP stdio server built on `@modelcontextprotocol/sdk`, bundled to `dist/omp-bridge.mjs` like `apps/server/build.mjs` bundles the server.
- **Inputs, all from the environment set by the server:**
  - `UCCH_OMP_BIN`
  - `UCCH_OMP_AGENT_DIR` (the subject's `omp/agent`)
  - `UCCH_OMP_OVERLAY` (a bridge overlay: §4 with `task.maxConcurrency: 2`, `memory` as the workspace has it, and `tools.approval` denying `bash` for read-only tools)
  - `OPENROUTER_API_KEY`
  - `UCCH_WORKTREE`
  - `UCCH_BRIDGE_MAX_SECONDS`
- It reuses `omp-rpc.ts` from `@ucch/providers` and has no other runtime dependencies.

### 10.2 Tools
Every tool:
- spawns one `omp --mode rpc --no-session` process;
- sends one `prompt`;
- collects the final assistant text, or the subagent's structured output;
- closes.

`--model @smol` unless stated otherwise. `--max-time ${UCCH_BRIDGE_MAX_SECONDS}s`. `--approval-mode yolo` with a `--tools` allowlist, because headless prompts fail ([approvals](https://omp.sh/docs/approvals)), and the call's guard overlay as the last `--config` (below, OM6.8): the allowlist bounds the session, the guard bounds the subagents it spawns.

| Tool | Input schema | OMP side | `--tools` |
|---|---|---|---|
| `omp_task` | `{ agent: "scout"\|"reviewer"\|"security-reviewer"\|"sonic", assignment: string, files?: string[] }` | prompt: "Use the `<agent>` subagent: `<assignment>`" (bundled agents only, §6.4) | `read,grep,glob,lsp,task` (sonic adds `edit,write`; scout adds `web_search` for research) |
| `omp_review` | `{ scope: "uncommitted"\|"branch"\|"commit", ref?: string, focus?: string }` | OMP's headless review request, with the diff from git (§9; OM6.2) | `read,grep,glob,task` |
| `omp_symbols` | `{ op: "definition"\|"references"\|"implementations"\|"type"\|"diagnostics", symbol?: string, file?: string, line?: number, packageDir?: string }` | "Using the lsp tool only, …" | `lsp,read` |
| `omp_rename` | `{ symbol: string, file: string, line?: number, newName: string, apply: boolean }` | LSP rename, previewed; applied when `apply` | `lsp,read` (+`edit,write` when apply) |
| `omp_codemod` | `{ description: string, pattern?: string, rewrite?: string, language?: string, paths?: string[], apply: boolean }` | `ast_edit` propose, then accept when `apply` | `ast_edit,read` (+`write` when apply; OM6.2) |
| `omp_debug` | `{ goal: string, program?: string, args?: string[], attachPid?: number, breakpoints?: {file, line, condition?}[] }` | debug session, returns findings (no fix) | `debug,read,bash,grep` · `--model @default` |
| `omp_recall` | `{ query: string }` | §7.3 | `recall` (OM6.2: `@smol`) |
| `omp_retain` | `{ fact: string, kind?: "convention"\|"decision"\|"lesson" }` | §7.3 | `retain` (OM6.2: `@smol`) |
| `omp_handoff_brief` | `{ focus?: string }` | brief from the *calling CLI's* own summary of the session (passed in as `transcript`) | none |

**Result format.** Text content, at most 64 KB, with usage and cost appended as a final line (`omp: 3.1k in / 0.8k out · $0.004 · 21 s`), so the CLI's transcript records cost.

**Errors.** Timeouts, missing auth and OMP failures return `isError: true` with a one-line reason. They never throw.

**As built (OM6.2),** measured with 18.14.1 against the scripted model (spike report, "Measured later"):
- **`--tools` must name only tools the session has.** A missing one stops OMP before `ready` ("Built-in tool unavailable in this session"). `ast_grep` exists only with `astGrep.enabled`, which is off by default, and `ast_edit` matches as well as rewrites, so `omp_codemod` runs without it. `recall` and `retain` exist only with memory on, so the bridge reads `UCCH_OMP_MEMORY=1` and answers "memory is off" without starting OMP. Likewise `web_search` for a scout needs `UCCH_OMP_WEB_SEARCH=1`.
- **There is no `tiny` role** (the role set is `default, smol, slow, plan, vision, commit`), so recall and retain run on `@smol`. With `scoping: global` and a per-project `dbPath`, a fact retained by one process is recalled by the next.
- **Allowlisted tools are top-level.** `lsp`, `ast_edit` and `debug` are `xd://` devices in a default session, but under `--tools` they are ordinary tools. Their action names are the binary's (`implementation`, `type_definition`; `lsp` `rename` applies unless `apply: false`). A rename preview needs no write tool and changes nothing; an applied one edits through the language server.
- **A codemod preview ends itself.** `ast_edit` only stages a proposal. OMP then forces the model to `write` it to `xd://resolve` or `xd://reject`, and a call with no `write` fails after three forced turns. So the preview gets `ast_edit,read` only, and the bridge sends `abort` once `ast_edit` has answered (`stopAfter`), returning the staged diff. Denying `write` by policy does not help: `xd://reject` is not a device with its own approval key.
- **`/review` is not a command under `--no-extensions`.** The model receives the literal text. `omp_review` sends OMP's own headless review request (the text `/review` expands to) with the diff the bridge reads from git, and answers with the reviewer subagent's result.
- **The whole exchange is timed.** `--max-time` plus 30 s covers the stats and prompt commands as well as the wait, so a process that stops answering cannot hold the CLI's tool call.
- **The call's guard** (OM6.8, `packages/omp-bridge/src/guard.ts`). `--tools` does not reach subagents: each gets its own agent's tools. Under `--tools read,grep,glob,task`, an `omp_task` reviewer got `bash` and `web_search`, and its `bash` ran; a sonic got `bash`, `eval` and `web_search`; a scout `web_search` without `UCCH_OMP_WEB_SEARCH`. So every call writes a guard (0600, in its own temp directory, removed when the call ends) passed after the bridge overlay. It sets `tools.approval: deny` for every tool of the pinned version that the call does not name, except `read, glob, grep, find, ast_grep, inspect_image, todo, wait, checkpoint, rewind`; a denied tool stays in the schema and answers `Tool "bash" is blocked by user policy`. It also sets `web_search.enabled` only when the call names it, `dev.autoqa: false` (otherwise `xd://report_issue` is mounted and can report to qa.omp.sh), telemetry export off, the project sources off as in §4, and `disabledProviders` to OMP's sources for other agents' configuration (`OMP_FOREIGN_SOURCES`). OMP opts Claude Code's in whenever `CLAUDE_CONFIG_DIR` is set, and a bridge call from a Claude Code then mounted that Claude Code's own `omp` server as `xd://mcp__omp_*` devices.
- **No language server or debugger for an untrusted project** (§0.3). A cloned repository's own LSP and debug-adapter config would run, so `lsp` and `debug` need `UCCH_OMP_TRUSTED=1`. Without it every call passes `--no-lsp`, `omp_task` drops `lsp` from its list, and `omp_symbols`, `omp_rename` and `omp_debug` answer "off for this project" without starting OMP. The server sets the variable from the project's trust (OM7.6).

### 10.3 Wiring

**Claude Code (`claudeArgv`, `packages/providers/src/claude.ts`):**
- New input `mcpConfigPath?: string`. When set, append `--mcp-config <path> --strict-mcp-config`. Strict mode means only UCCH's servers load, which matches `--setting-sources user`.
- The JSON is written per run to `<subject>/claude/run/<turnId>.mcp.json`:
  `{"mcpServers":{"omp":{"command":"node","args":["/opt/ucch/omp-bridge.mjs"],"env":{…}}}}`
- `probeClaude` detects `--mcp-config` in `--help` (a `caps` flag, as is done for `settingSources`).
- **Permissions.** Under `normal`, the read-only tools are pre-allowed with `--allowedTools "mcp__omp__omp_symbols mcp__omp__omp_recall mcp__omp__omp_review mcp__omp__omp_task"`; the others ask through the existing `--permission-prompt-tool stdio` flow. Under `strict` everything asks. Under `allow_all` nothing asks (the existing `#allowAll` path).
- **The MCP server's `env` carries `OPENROUTER_API_KEY`.** That is the bridge's environment, not the CLI's. Claude Code still has no API key in its own environment, so `forbiddenEnvPresent` still holds for the CLI. The key sits in a 0600 file for the turn's duration and is deleted after.

**As built (OM6.4),** checked with Claude Code 2.1.316 against a scripted API, with real OMP behind the built bridge:
- **The setting.** `agent_settings.ompBridge.enabled`, off by default, under Workspace settings → Harness. A Claude Code turn gets the bridge only when it is on, the server has `OMP_BRIDGE_BIN`, and the account has an OpenRouter key to bill. Without a key the turn runs as before, without the tools.
- **Files.** The MCP config is `<subject>/claude/run/<turnId>.mcp.json` (0600). The bridge's overlay is `<subject>/omp/run/bridge-<turnId>.yml`. It uses the Allow All approval mapping, because the bridge's `omp` is headless and the person has already been asked about the tool itself. It runs two workers, every role is the account's OpenRouter model, and it is untrusted. Both files are deleted, and the scheduler token revoked, when the turn ends.
- **Command.** `command` is the server's own `node` (`process.execPath`), not `node` on the CLI's `PATH`. The `env` carries the bridge's settings (`UCCH_BRIDGE_MAX_SECONDS` from `OMP_BRIDGE_MAX_SECONDS`) and the OpenRouter key; the CLI's environment carries no key at all (`agent.test.ts`).
- **Flags.** `probeClaude` detects the flags by `--strict-mcp-config` in `-p --help`. `--allowedTools` is variadic, so each tool is its own argument; every argument that follows is a flag.
- **Prompts.** An MCP tool that is not allowed comes back as a `can_use_tool` control request with `tool_name: "mcp__omp__<tool>"`. `claudePromptNeedsPerson` sends a bridge tool to a person unless the mode is Allow All, or the mode is Normal and the tool is one of the four read-only ones. `omp_ping` is not one of them.
- **MCP tools are deferred.** In 2.1.316 they are not in the request's `tools` until the model loads them with `ToolSearch` (`select:mcp__omp__omp_symbols`). Claude Code's own model does this unprompted; a guide (§10.4) should name the tools so the model knows to look for them.

**Codex (`codexArgv`, `codex.ts`):**
- Append `-c mcp_servers.omp.command="node"`, `-c mcp_servers.omp.args=["/opt/ucch/omp-bridge.mjs"]` and `-c mcp_servers.omp.env.UCCH_…=…`. OM0 confirmed the syntax (Codex 0.166.0: `codex -c 'mcp_servers.omp.command="node"' -c 'mcp_servers.omp.args=[…]' -c 'mcp_servers.omp.env.X="…"' mcp list` lists the server, enabled), so no `config.toml` fallback is needed.
- The key does not go through `-c` (argv): it goes in a 0600 file the bridge reads (as built, below). OM6.5 checked whether `codex exec` calls the tool, and whether the server has network under `workspace-write`; both do. `codex exec --help` scopes `--sandbox` to "model-generated shell commands", which an MCP server is not.

**As built (OM6.5),** measured with Codex 0.166.0 `exec` against a scripted Responses API (spike report, "Measured later"):
- **The key is not in argv.** `-c` values are Codex's own argv, which every user on the host can read in `ps`. So the bridge's environment goes in `<subject>/codex/run/<turnId>.bridge.json` (0600). The argv carries only `mcp_servers.omp.env.UCCH_BRIDGE_ENV_FILE="<path>"`, and the bridge reads the file in (`withEnvFile`; its values win). The file is deleted with the turn.
- **Pre-approved.** `codex exec` refuses an MCP tool not marked read-only ("MCP tool call requires approval, but approval policy is never"). The flags therefore set `default_tools_approval_mode="approve"`. Codex already acts unasked in its sandbox, since UCCH's permission modes do not reach it, and so do the bridge's tools.
- **Timeout.** `tool_timeout_sec` is `OMP_BRIDGE_MAX_SECONDS` plus 70 s: the bridge's 35 s wait for a slot and its 30 s grace on the exchange.
- **Runtime.** The MCP server is not sandboxed under `workspace-write`: it reached the scheduler socket and OMP's model. Its environment is `HOME`, `PATH` and the configured `env` only. The model sees the tools as one `mcp__omp` namespace, and the stream reports each call as an `mcp_tool_call` item. A real `codex exec` called `omp_task` scout through the real bridge and OMP.
- **Same setting.** `agent_settings.ompBridge` covers both CLIs, as do the key rule (no key, no bridge), the overlay and the token.

**CLIs started by hand (`apps/server/src/shell/ucch.bashrc`, `ucch.fish`):** the `claude()` and `codex()` wrappers already add knowledge. They gain `--mcp-config "$UCCH_OMP_MCP"` and `-c mcp_servers.omp…` when the workspace has the bridge enabled. The terminal reactor exports `UCCH_OMP_MCP` (a per-terminal 0600 file).

**As built (OM6.7):**
- **The path is fixed first.** `TerminalReactor.#open` is synchronous, and the setting is a database read. So a project shell always gets `UCCH_OMP_MCP=<subject>/omp/run/term-<terminalId>.mcp.json`, and `TerminalBridge.open` writes the files just after, only with the setting on and a key. The wrappers add the flags only while the file exists, so without the bridge both CLIs run exactly as before. Sign-in terminals get neither.
- **Files.** Each is 0600 and written atomically:
  - `term-<id>.bridge.json`: the environment and key, named by `UCCH_BRIDGE_ENV_FILE`;
  - `term-<id>.codex`: Codex's `-c` arguments, one per line;
  - `term-<id>.mcp.json`: Claude Code's config, written last because its existence means "ready";
  - `bridge-term-<id>.yml`: the overlay.

  A lease token is registered as well. All of it goes when the terminal closes or its shell exits, and shutdown waits for it (`closeAll`).
- **Key and model.** The key is the terminal's credential subject's: the workspace key for `ws-<id>`, the person's otherwise. The model is the person's default.
- **`--mcp-config=<path>`.** The flag is variadic (`<configs...>`), so `claude --mcp-config <path> "fix it"` would read the prompt as a second config file. The wrapper uses the `=` form. The server's own argv puts a flag after it.
- **Nothing pre-approved.** A CLI started by hand asks its person itself, so there is no `--allowedTools` and no `default_tools_approval_mode`.
- **`claude mcp list` does not show `--mcp-config` servers** (2.1.316); a session's `mcp_servers` does. `codex -c … mcp list` shows it.

**This dev machine (optional, documented only).** `claude mcp add omp -- node <repo>/packages/omp-bridge/dist/omp-bridge.mjs`, with `UCCH_OMP_*` exported. The same bridge then works in a personal Claude Code session.

### 10.4 Telling the CLIs when to use it
A section appended to `instructions` for CLI providers when the bridge is on, about 25 lines in `packages/providers/assets/omp-bridge-guide.md`:
- Use `omp_task` with `scout` to explore more than about 10 files; it returns a summary and saves your context.
- Use `omp_symbols` / `omp_rename` for symbol-aware navigation and renames, instead of grep and replace.
- Use `omp_codemod` for the same mechanical change across many files.
- Use `omp_debug` when a bug needs runtime inspection.
- Use `omp_review` before declaring a multi-file change done.
- Use `omp_recall` at the start of unfamiliar work, and `omp_retain` for durable conventions or decisions.
- Each call costs tokens and takes 10–60 s, so do not call them for small things.

**As built (OM6.6):**
- **Where.** The guide is `packages/providers/assets/omp-bridge-guide.md`, read by `ompBridgeGuide()` and copied next to `server.mjs` by the server's `build.mjs`. It covers all nine tools, the cost line, and what to do when a tool is off, busy or out of calls (carry on, without retrying).
- **When.** It is added after the project's knowledge when the turn is actually given the bridge (`#openBridge`, so a missing key means no guide). It is logged as `context.injected` with a new source, `omp_bridge`. With the bridge off, the instructions are byte for byte what they were.
- **Resumed Codex.** Codex reads instructions only at the start of a session (`codexPrompt`), so a resumed Codex turn is not given the guide, and nothing is logged for it. The tools' own descriptions still reach its model.
- **In step.** `packages/omp-bridge/src/guide.test.ts` checks that the guide names exactly the tools the bridge offers.

### 10.5 Limits
- Bridge calls count as OMP processes in the scheduler (§13) through a lease. The bridge asks the server for a slot over a local Unix socket (`UCCH_SCHEDULER_SOCK`) and waits up to 30 s; if no slot comes, it returns "busy, try later".
- A per-turn call budget (`UCCH_BRIDGE_MAX_CALLS`, default 12) is enforced in the bridge.

**As built (OM6.3):**
- **Scheduler.** `TurnScheduler.lease({ ownerId, threadId, waitMs })` is an `omp` acquire that gives up after `waitMs` and resolves null, freeing its place in the queue.
- **Socket.** `apps/server/src/bridge-leases.ts` listens on `<CREDS_ROOT>/omp-scheduler.sock` (mode 0600) once the HTTP server is up. The protocol is one line each way, `{type:"lease",token}`, answered `granted`, `busy` after 30 s, or `refused`.
- **The connection is the lease.** The slot is held until the bridge closes it, so a bridge that crashes, or dies with its CLI, gives the slot back.
- **Tokens.** A per-turn token (`UCCH_BRIDGE_TOKEN`, registered when OM6.4 writes the MCP config) names the turn. Nothing else can take a slot.
- **Bridge.** `lease.ts` checks the budget first, then the slot. A call refused as busy or over budget does not count against the budget, and never starts `omp`.
- **Fail closed.** With `UCCH_SCHEDULER_SOCK` set but no answer, or no server, the call is refused rather than run unmetered. Without it (the dev-machine recipe) only the budget applies.

---

## §11 Native loop: fallback and retirement

1. **OM2–OM7.** `ProviderId` keeps `native`. With `OMP_ENABLED=true`, new threads whose provider resolves to `native` are created as `omp` instead (`resolveProvider`, §12.3). Threads already bound to `native` stay native: their history is in the native session log, which OMP cannot resume.
2. **OM8, release N.** `NATIVE_LOOP_FALLBACK=true` keeps native-bound threads working. A metric counts native turns (`agent_turns_total{provider="native"}`).
3. **Release N+1, after 14 days with no native turns, or after native threads are archived:**
   - delete `packages/agent/src/loop.ts`, `completion.ts`, `context.ts`, `session-log.ts`, `arguments.ts` and the `fs` / `search` / `shell` / `web` tools;
   - keep `tool.ts`, `executor.ts`, `executors/`, `registry.ts` (reduced to the host tools), `tools/{documents,uploads,research,system,format}.ts`, `prompt.ts` (`renderKnowledge`) and `run-tool.ts`;
   - remove `apps/server/src/openrouter.ts` `streamCompletion` if nothing else uses it. Research's OpenRouter search stays for CLI turns' research phase, unless that also moves to OMP (a `scout` with `web_search`, §6.4).
   - Rename the UI label: `PROVIDER_LABELS.omp = "Custom"`, with `native` gone from the enum. That needs a migration mapping the stored `native` account defaults to `omp`.

---

## §12 Server, protocol and web changes

### 12.1 Protocol (`packages/protocol/src/events.ts:269-274`)
- `ProviderId = z.enum(["native", "claude", "codex", "omp"])`
- `CliProviderId = z.enum(["claude", "codex", "omp"])`. OMP keeps a session to resume, which is the type's meaning.
- New events, all in §App. B: `agent.subagent_*`, `context.usage`, `thread.handoff_requested`, `thread.handed_off`, `review.completed`.
- New commands: `thread.compact`, `thread.handoff`, `thread.handoff_to`, `review.run`.

### 12.2 Providers package
- `registry.ts`: `PROVIDER_LABELS.omp = "Custom"` (and `native` becomes "Custom (legacy)"). `isCliProviderId` adds `"omp"`. `createProviders({ ..., ompBin })` adds `omp: new OmpProvider(ompBin)`.
- `types.ts`: `FORBIDDEN_ENV` stays for the CLIs. New `ALLOWED_CREDENTIAL_ENV: Record<CliProviderId, readonly string[]>`, which is `[]` for claude and codex and `["OPENROUTER_API_KEY"]` for omp. New `forbiddenEnvFor(id, env)` rejects any variable on the [env](https://omp.sh/docs/env) credential list that is not allowed for `id`. That is a constant list in `omp-credentials.ts`, with a test that it includes `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_CODEX_OAUTH_TOKEN`, `GEMINI_API_KEY` and `XAI_API_KEY`.
- `ProviderRunInput` gains:
  - `mcpConfigPath?` (claude, codex)
  - `overlayPath?`, `sessionDir?`, `trusted?`, `hostTools?` (omp)
  - `onHostToolCall?(call): Promise<HostToolResult>`, the server-supplied runner.

### 12.3 Server
- **`agent.ts`.**
  - `resolveProvider` gains `"omp"` in `known()`, plus a rule: when `OMP_ENABLED`, an unbound thread resolving to `native` becomes `omp`.
  - The CLI path (around line 775) handles `omp` with `apiKey` from `#decryptKey` (as in the native path, line 590), the overlay writer, and the host-tool runner.
  - `#cliPrompts` covers OMP's confirms.
- **`providers.ts`.**
  - `credsDir(userId, "omp")`.
  - `ensureCredsDir("omp")` creates `agent/`, `sessions/`, `run/` and `wt/`, installs the guard hook (§3.9), and writes `agent/config.yml` with `autoResume: false` and `OMP_SKIP_SETUP` semantics.
  - `providerEnv("omp", { openrouterKey })` per §3.3.
  - The `ProviderCard` for omp.
  - `provider(id)` returns OMP.
- **New `omp-overlay.ts`.** `writeOverlay({ subject, workspaceSettings, preset, permissionMode }) → path`, which is §4.
- **New `omp-review.ts`, `omp-handoff.ts`.** §9 and §5.4.
- **`turn-scheduler.ts`.** `TurnKind = "cli" | "native" | "omp"`, with `ompTotal` from `OMP_TURN_TOTAL`, plus a `lease()` API for bridge calls (§10.5).
- **`terminals.ts`.** `TerminalProgram` adds `"omp-login"`. Login argv: `omp` interactive with `PI_CODING_AGENT_DIR` set, the user runs `/login <provider>`. The terms warning comes first (§0.1).
- **`config.ts`.** The §1.3 keys. `index.ts:232` passes `ompBin` to `createProviders`.

### 12.4 Web (`apps/web/src/components/`)
- **`provider-picker.tsx`.** "Custom" maps to `omp` when enabled.
- **`provider-settings.tsx`.** An OMP card showing version, auth (OpenRouter key present or subscription login), memory stats and the bridge toggle.
- **`workspace-harness-settings.tsx`.**
  - Models: default, fast (smol), deep (slow), from the OpenRouter catalogue the account already uses.
  - Toggles: memory (with `llmMode`), economy (prewalk), advisor, browser, "OMP tools for Claude Code & Codex" (the bridge), "Verify with OMP", "Auto hand-off on limit" plus the fallback provider.
- **`agent-permission-settings.tsx`.** Explains the OMP mapping (§3.2).
- **`project-chat.tsx`.** Subagent cards (§6.3), compaction dividers (§5.1), the handoff links (§5.4), and the Compact / Hand off thread actions.
- **`context-meter.tsx`.** Reads `context.usage`.
- **`components/git/*`.** Review buttons and the findings overlay (§9.3).
- **Rules.** All new routes and panels follow `apps/web/CLAUDE.md`: skeletons, `TransitionLink`, a `loading.tsx` per route.

### 12.5 Database (`packages/db`)
- `threads.handoff_from_thread_id`, nullable.
- `reviews` projection table: `id`, `project_id`, `thread_id`, `scope`, `verdict`, `findings jsonb`, `cost_usd`, `created_at`.
- Workspace harness settings columns for the toggles, or the existing settings JSON if there is one (match the current pattern in `workspaces.ts`).
- A migration in OM8 maps `native` defaults to `omp`.

---

## §13 Observability and capacity

**Metrics** (`apps/server/src/metrics.ts`):
- `omp_processes{kind="turn"|"bridge"|"review"|"handoff"}`
- `omp_start_seconds`
- `omp_turn_seconds`
- `omp_subagents_total{agent}`
- `omp_compactions_total{method}`
- `omp_bridge_calls_total{tool,outcome}`
- `omp_cost_usd_total{kind}`
- the PF0.2 resource sampler gains an `omp` process class, plus `omp-lsp` for language servers

**Capacity.**
- OM0 measures RSS for an idle RPC process, one with a busy turn, one with 4 workers, and one with a TS language server running.
- `OMP_TURN_TOTAL` is then set so that `OMP_TURN_TOTAL × busy-RSS + LSP` stays within the budget `../plan.md` gives agent processes. `cliPerUser: 2` stays, and covers OMP turns too.

**Warm pool (later, only if `omp_start_seconds` p95 is above 2 s).** Keep N idle `omp --mode rpc` processes per subject and send `switch_session` on take. This is not built unless measured.

---

## §14 Testing

- **Fixtures (OM0).** `packages/providers/src/fixtures/omp-{plain,tool,confirm,compaction,handoff,subagent,host-tool,error}.jsonl` are recorded from the pinned version with a cheap OpenRouter model. They are re-recorded on every `OMP_VERSION` bump (todo OM8.6).
- **Unit tests (vitest).**
  - `omp-rpc.test.ts`: ready barrier, id correlation with out-of-order responses, v2 chunk reassembly, unknown frames ignored, close and exit.
  - `omp.test.ts`: `ompArgv` snapshots per mode and effort; `OmpNormaliser` against every fixture, with an exact event list; permission round trip; `forbiddenEnvFor`. This follows `claude.test.ts` and `codex.test.ts` with `testing.ts`'s fake host.
  - `omp-overlay.test.ts`: snapshots, plus every key present in `fixtures/omp-config-list.json`.
  - `omp-bridge/*.test.ts`: tool schemas, plus an argv and allowlist per tool, against a fake `omp` script that replays fixtures.
  - `claude.test.ts`: `--mcp-config` / `--strict-mcp-config`, and subagent events from a recorded Task stream (a new fixture, `claude-task.jsonl`).
  - `agent.test.ts`: `resolveProvider` with `OMP_ENABLED`, and that bound native threads stay native.
- **Fake OMP for load tests.** `scripts/load/fake-omp.mjs`, like `fake-claude.mjs` (PF0.5), replays the RPC fixtures with `--rss-mb`.
- **e2e (Playwright).** A Custom turn against `fake-omp`; a subagent card; compaction divider; the Review button against a fixture; Hand off to another provider (fake CLIs).
- **Manual acceptance per phase:** listed in `todo.md`.

---

## Appendix A: Environment variables

| Variable | Set by | For |
|---|---|---|
| `OMP_BIN`, `OMP_ENABLED`, `NATIVE_LOOP_FALLBACK`, `OMP_BRIDGE_BIN`, `OMP_TURN_TOTAL`, `OMP_WORKERS_PER_TURN`, `OMP_BRIDGE_MAX_SECONDS` | operator (`.env`) | server config §1.3 |
| `PI_CODING_AGENT_DIR`, `OMP_WORKTREE_DIR`, `OMP_SKIP_SETUP`, `PI_TASK_MAX_OUTPUT_BYTES`, `PI_NATIVES_DIR`, `OPENROUTER_API_KEY` | server, per run | OMP process §3.3 ([env](https://omp.sh/docs/env)) |
| `JS_DEBUG_DAP_SERVER` | image | DAP §8.3 |
| `UCCH_OMP_BIN`, `UCCH_OMP_AGENT_DIR`, `UCCH_OMP_OVERLAY`, `UCCH_WORKTREE`, `UCCH_BRIDGE_MAX_SECONDS`, `UCCH_BRIDGE_MAX_CALLS`, `UCCH_SCHEDULER_SOCK`, `UCCH_BRIDGE_TOKEN`, `UCCH_OMP_MEMORY`, `UCCH_OMP_WEB_SEARCH`, `UCCH_OMP_TRUSTED` | server, in MCP config | bridge §10 |
| `UCCH_OMP_MCP` | terminal reactor | hand-started CLIs §10.3 |
| `UCCH_BRIDGE_ENV_FILE` | server, in Codex's `-c` and the terminal's MCP config | bridge §10.3: the 0600 file holding the bridge's environment |

## Appendix B: Protocol additions

- **Events:**
  - `agent.subagent_started`, `agent.subagent_progress` (transient), `agent.subagent_finished`, all §6.1;
  - `context.usage` (transient), §5.2;
  - `thread.handoff_requested`, `thread.handed_off`, §5.4;
  - `review.completed`, §9.2.
  - `agent.session_started.provider` accepts `omp`, via `CliProviderId`.
- **Commands:** `thread.compact`, `thread.handoff`, `thread.handoff_to`, `review.run { projectId, threadId?, scope, ref?, focus? }`.

## Appendix C: File index

**New**
- `packages/providers/src/omp.ts`, `omp-rpc.ts`, `omp-rpc-types.ts`, `omp-credentials.ts`, plus tests
- `packages/providers/src/fixtures/omp-*.jsonl`, `omp-config-list.json`, `claude-task.jsonl`
- `packages/providers/assets/omp-hooks/ucch-guard.ts`, `assets/omp-bridge-guide.md`, `src/omp-roles.ts` (§6.4)
- `packages/omp-bridge/` (`src/index.ts`, `src/tools/*.ts`, `build.mjs`, tests)
- `packages/agent/src/run-tool.ts`
- `apps/server/src/omp-overlay.ts`, `omp-review.ts`, `omp-handoff.ts`, `bridge-leases.ts`, `omp-bridge-config.ts`, `terminal-bridge.ts`, plus tests
- `scripts/load/fake-omp.mjs`
- `documentation/omp/spike-report.md` (OM0 output)

**Changed**
- `packages/protocol/src/events.ts`, `commands.ts`
- `packages/providers/src/types.ts`, `registry.ts`, `claude.ts`, `codex.ts`
- `apps/server/src/agent.ts`, `providers.ts`, `turn-scheduler.ts`, `terminals.ts`, `config.ts`, `index.ts`, `task-pipeline.ts`, `metrics.ts`, `shell/ucch.bashrc`, `shell/ucch.fish`
- `packages/db` (schema and migration)
- `apps/web/src/components/provider-picker.tsx`, `provider-settings.tsx`, `workspace-harness-settings.tsx`, `agent-permission-settings.tsx`, `project-chat.tsx`, `context-meter.tsx`, `components/git/*`, `lib/context-window.ts`
- `Dockerfile`, `.env.example`, `.env.development.example`, `README.md`, `deploy.md`

**Removed (release N+1, §11)**
- `packages/agent/src/loop.ts`, `completion.ts`, `context.ts`, `session-log.ts`, `arguments.ts`, `tools/{fs,search,shell,web}.ts`, and the matching tests

## Appendix D: OMP doc index (what each section relies on)

| Page | Sections |
|---|---|
| [rpc](https://omp.sh/docs/rpc) | §2, §3, §5, §6 |
| [modes](https://omp.sh/docs/modes), [cli](https://omp.sh/docs/cli) | §3.1, §9, §10 |
| [settings](https://omp.sh/docs/settings), [env](https://omp.sh/docs/env) | §0.3, §3.3, §4 |
| [approvals](https://omp.sh/docs/approvals) | §3.2, §3.5, §10.2 |
| [compaction](https://omp.sh/docs/compaction), [handoff](https://omp.sh/docs/handoff) | §4, §5 |
| [subagents](https://omp.sh/docs/subagents), [subagent-authoring](https://omp.sh/docs/subagent-authoring), [agents-and-roles](https://omp.sh/docs/agents-and-roles) | §4, §6 |
| [memory](https://omp.sh/docs/memory) | §4, §7 |
| [editing](https://omp.sh/docs/editing), [code-intelligence](https://omp.sh/docs/code-intelligence), [debugging](https://omp.sh/docs/debugging), [tools](https://omp.sh/docs/tools) | §8, §10 |
| [review](https://omp.sh/docs/review) | §9 |
| [hooks](https://omp.sh/docs/hooks) | §0.3, §3.9 |
| [mcp](https://omp.sh/docs/mcp), [skills](https://omp.sh/docs/skills), [context-files](https://omp.sh/docs/context-files), [plugins](https://omp.sh/docs/plugins) | §0.3, §3.8 |
| [providers](https://omp.sh/docs/providers), [quickstart](https://omp.sh/docs/quickstart) | §0.1, §1 |
| [sessions](https://omp.sh/docs/sessions) | §3.1, §5.4 |
| [plan](https://omp.sh/docs/plan), [prewalk](https://omp.sh/docs/prewalk), [advisor](https://omp.sh/docs/advisor) | §4, plan §6.9 |
| [sdk](https://omp.sh/docs/sdk) | why RPC rather than the SDK (Bun only) |
