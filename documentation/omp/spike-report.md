# OMP spike report (OM0)

**Date:** 2026-10-31 · **OMP:** 18.14.1 · **Tasks:** [`todo.md`](./todo.md) OM0.1–OM0.6 · **Design:** [`solution.md`](./solution.md)

What the docs did not settle, answered by running the pinned OMP. Every answer names the fixture line or the probe that shows it. Where an answer contradicts `solution.md`, that section has been corrected in the same commit (listed in [Corrections](#corrections-made-to-solutionmd)).

**Model.** No OpenRouter model was used. Every fixture and probe runs real OMP against `scripts/omp/scripted-model.mjs`, a local OpenAI-compatible server that answers from a script. The RPC frames are OMP's own; only the model's replies are fixed. That makes every fixture free and identical on re-record, which is what OM8.6 needs. The model id in every fixture is `scripted/scripted`. One Claude Code call (OM0.5 Q1, haiku, $0.0026) went to the operator's subscription.

**Scripts** (all under `scripts/omp/`):

| Script | What it does |
|---|---|
| `record-rpc.mjs` | records the `omp-*.jsonl` fixtures from `scenarios.mjs`; `--check` re-parses them |
| `probe-safety.mjs` | plants project-scope OMP config in a scratch repo and reports what loads (OM0.4) |
| `measure-rss.mjs` | startup time and memory (OM0.6) |
| `scripted-model.mjs` | the fake model behind all three |

**Disk.** OMP unpacks ~120 MB of native modules into `$HOME/.omp/natives/<version>/` on first start. A probe that gives every run a fresh `HOME` fills a tmpfs `/tmp` within minutes (the first OM0.4 run did, and every later run failed with "natives not found"). All scripts now share one directory through `PI_NATIVES_DIR`. The image must do the same (OM1.5): set `PI_NATIVES_DIR` to a directory under `/opt/omp` and warm it at build time.

---

## OM0.1 — Install and pin

| | |
|---|---|
| Version | **18.14.1** (released 2026-10-31T01:13Z, stable channel) |
| Release | <https://github.com/can1357/oh-my-pi/releases/tag/v18.14.1> |
| Asset | `omp-linux-x64`, 276 416 688 bytes |
| SHA-256 | `02d76a0cfeee473ffa387f50cf0378b0de1c44684c83e67ca27ba4d717cfb0d0` |
| Same file from the build service | `https://build.stencil.so/api/products/omp/versions/18.14.1/linux-x86_64` reports the same SHA-256 |

**The install script** (`curl -fsSL https://omp.sh/install`, read in full):
- **Version pin: yes.** `--binary --ref v<version>` fetches that release; a bare `--ref` means a *source* build with Bun.
- **Install directory: yes.** `PI_INSTALL_DIR` (default `~/.local/bin`).
- **Checksum: yes.** It checks the build service's SHA-256 before moving the file into place.
- **Default route:** if `bun` is on `PATH` and matches the host architecture, it installs from npm with Bun (`bun install -g @oh-my-pi/pi-coding-agent`) instead of the binary. The image must pass `--binary` explicitly, or a Bun in a later layer changes the route.

**Runtime dependencies.** The binary is a self-contained Bun-compiled executable: `ldd` lists only `libc`, `libpthread`, `libdl`, `libm` and the glibc loader. It does **not** need Bun at run time. It is glibc-linked, which matches the `node:22-bookworm-slim` base. (The musl build links `libstdc++`/`libgcc` dynamically; not relevant here.)

**Image route (answers plan §9 Q8):** download the GitHub release asset directly, check it against the pinned SHA-256, `chmod +x` into `/opt/omp/bin/omp`. That is solution §1.1 route (b). The script adds nothing the image needs, and it would resolve the download through a second service.

**Fixtures.** `omp --help` → `packages/providers/src/fixtures/omp-help.txt`; `omp config list --json` → `fixtures/omp-config-list.json` (576 settings), both recorded with an empty `HOME`.

```
$ omp --version
omp/18.14.1
```

---

## OM0.2 — RPC transcripts

`node scripts/omp/record-rpc.mjs` records each scenario in `scenarios.mjs` with `omp --mode rpc-ui --no-title`. Every line is `{"dir":"in"|"out","frame":{…}}`; throwaway paths become `<home>` / `<cwd>` / `<base>`, ports `<port>`, and `sk-…` strings `<redacted>`.

| Fixture | What it records | Ends with |
|---|---|---|
| `omp-plain` | one text answer, `get_state`, `get_session_stats` | `agent_end` (terminal) |
| `omp-tool` | `read` then `write` | `agent_end` |
| `omp-confirm` | `--approval-mode write`, two `bash` calls: one approved, one denied | `agent_end` |
| `omp-compaction` | four turns over a 50-token threshold: two successful automatic compactions, then a manual `compact` that is skipped ("Already compacted"), `get_messages` | `agent_end` |
| `omp-handoff` | two turns, the RPC `handoff` command, `get_messages` | `agent_end` |
| `omp-subagent` | `set_subagent_subscription progress`, one `scout` task | `agent_end` (terminal, after a non-terminal one) |
| `omp-host-tool` | `set_host_tools` with `ucch_echo`, called by name | `agent_end` |
| `omp-host-tool-xd` | the same tool reached the way a real model reaches it: `write` to `xd://ucch_echo` | `agent_end` |
| `omp-host-tool-write-denied` | a host call and a file write under `write: deny` with the host tool allowed (OM3.4) | `agent_end` |
| `omp-host-tool-error` | a host call answered `isError: true` (OM3.2) | `agent_end` |
| `omp-host-tool-cancel` | a host call still running at an `abort`, then a late result (OM3.2) | `agent_end` |
| `omp-error` | the model API answers HTTP 400 | `prompt_result` `status: "error"` |
| `omp-retry` | HTTP 503, then an answer | `agent_end` |
| `omp-resume` | a turn, `new_session`, `switch_session` back, a second turn | `agent_end` |

**"An invalid model" cannot be an RPC fixture.** `--model nonexistent/nope` exits with code 1 **before** `ready`, with `Model "nonexistent/nope" not found` on stderr. `omp-error` therefore records the other kind of failure, an API error mid-turn. The provider must treat "exited before `ready`" as a failed turn with stderr as the reason (§3.4 last row already says so).

**Protocol v2** (todo step 3; not a fixture, because the frames are megabytes). After `{"type":"negotiate_protocol","protocolVersion":2}` the response is `{"command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}`. A `read` never produces a big frame (the tool pages its output), so the probe used a `write` with 1.5 MB of content. Every frame above 1 MiB then arrived as `rpc_chunk`:

```json
{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":12,"byteLength":3000571,"data":"eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIs…"}
```

- `data` is base64 of a slice of the UTF-8 frame, at most 262 144 bytes before encoding;
- `byteLength` is the **whole** frame's length, the same on every chunk;
- `count` chunks with `index` 0…count−1 per `chunkId`, in order. Concatenating the decoded slices gives one JSON frame (all nine chunked frames in the probe parsed: `message_start`, three `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `turn_end`, `agent_end`).
- `ready` advertises `maxFrameBytes: 1048576` and `maxReassembledFrameBytes: 67108864`.

```
$ node scripts/omp/record-rpc.mjs --check
omp-compaction.jsonl: 172 lines … omp-tool.jsonl: 47 lines     (exit 0)
```

---

## OM0.3 — RPC answers

### Q1. Session id and resume (§3.1)
- **The id comes from `get_state`** (`data.sessionId`, plus `data.sessionFile`) — `omp-plain.jsonl:6`, and from `get_session_stats` (`omp-plain.jsonl:26`). **No `session_info_update` frame is emitted** for a new session in any fixture. The provider asks `get_state` after `ready`.
- **`--resume <id>` works in RPC mode with `--session-dir`.** Probe: process A ran a turn in `--session-dir D` and exited 0; process B started with `--session-dir D --resume <id>` reported the same `sessionId` and `messageCount: 2`, ran a turn, and had 4. A unique id *prefix* also resumes. `switch_session` is not needed (it works too: `omp-resume.jsonl:28`).
- **An unknown id** exits 1 before `ready`: `Error: Session "<id>" not found.` The provider must surface that as a failed turn, and the server may then start a fresh session (the thread's history is in UCCH's log either way).
- With `--session-dir` the session file is `<dir>/<timestamp>_<id>.jsonl`, flat (no per-cwd subdirectory).

### Q2. Approvals in `rpc-ui` (§3.5)
- **Not `confirm`: `select`.** A tool approval is `extension_ui_request` with `method: "select"`, a `title` starting `Allow tool: <name>` followed by a summary, and three options — `omp-confirm.jsonl:17`:
  ```json
  {"type":"extension_ui_request","id":"15bb4296eaba7a53","method":"select","title":"Allow tool: bash\nCommand: ls","options":["Approve","Approve bash for this session","Deny"]}
  ```
- **The answer** is `{"type":"extension_ui_response","id":…,"value":"Approve"}` (or `"Deny"`) — `omp-confirm.jsonl:18`, `:32`.
- **Tying it to the call:** the payload carries no tool call id. It arrives after `tool_execution_start` of the call it gates and before that call's `tool_execution_end` (`:16` → `:17` → `:20`). Tool approvals are sequential, so the open call is the most recent `tool_execution_start` without an end.
- **A deny** ends the call with `isError: true` and the text `Tool call denied by user: bash` (`:33`). A reason cannot be passed back, as §3.5 already says.
- **Modes, measured:** `always-ask` asks before `write` and runs `read` unasked; `write` runs reads and writes and asks before `bash`; `yolo` asks nothing. Host tools mounted under `xd://` are tier `exec` (`omp-host-tool-xd.jsonl:22`, `details.xdev.tier`), so they ask under `write` unless `tools.approval` allows them.
- **`tools.approval.<tool>: deny`** in an overlay wins under `--approval-mode yolo`: `Tool "bash" is blocked by user policy.`
- **Devices, measured for OM2.5** (`scratchpad/probe/approve.mjs`): an `xd://<device>` write checks the device's own `tools.approval` key, then falls back to `write` ([approvals](https://omp.sh/docs/approvals) says the same). Under `--approval-mode write`, `write: allow` alone ran the host tool `ucch_echo` **unasked**; `ucch_echo: prompt` asked; a project `.omp/config.yml` `ucch_echo: allow` ran it unasked unless the overlay named `ucch_echo`. `debug: deny` blocked a write to `xd://debug` under yolo. So the line above ("ask under `write` unless `tools.approval` allows them") holds only while nothing sets `write: allow`, and the overlay names every device. A key naming no tool (`zz_nope: deny`) is harmless.
- **The default `tools.approvalMode` is `yolo`** (`omp-config-list.json`). UCCH must always pass `--approval-mode`.
- `rpc-ui` is required: plain `rpc` has no UI channel to ask on.

### Q3. Host tools (§3.7)
- **Schema format: JSON Schema.** `set_host_tools { tools: [{ name, label, description, parameters: <JSON Schema> }] }` is accepted and answered `{"data":{"toolNames":["ucch_echo"]}}` — `omp-host-tool.jsonl:2`, `:7`.
- **Host tools are not top-level model tools.** With the default `tools.xdev: true`, OMP mounts them as `xd://<name>` devices (`notice` "xd://: mounted ucch_echo", `:6`). The system prompt lists `xd://ucch_echo — Echo text back from the host.` under "xd:// Tool Devices", and the model calls one by `write`-ing its JSON arguments to that path. A tool call named `ucch_echo` directly is also dispatched (`omp-host-tool.jsonl`), but a real model follows the prompt (`omp-host-tool-xd.jsonl`). `tools.xdev: false` would expose every tool top-level, built-ins included; not proposed.
- **`host_tool_call` fields:** `{ id, toolCallId, toolName, arguments }` (`omp-host-tool-xd.jsonl:19`). `toolName` is the host tool's name even when the model wrote to `xd://`. Answered with `{ type: "host_tool_result", id, result: { content: [{ type: "text", text }] } }`.
- **Yes, OMP also emits `tool_execution_*` for a host call**, so UCCH must **not** add its own `agent.tool_use` / `agent.tool_result` (§3.4 corrected). Order: `host_tool_call` → `host_tool_result` → `tool_execution_start` → `tool_execution_end`. Through `xd://` the execution frames name the tool **`write`** with `args.path: "xd://ucch_echo"` and `args.content` the JSON; `tool_execution_end.result.details.xdev` has `{ tool, mode: "execute", args, tier }`. The normaliser maps a `write` to `xd://<tool>` back to `<tool>` with the parsed content as input, and never reports it as a file change.
- **A failed host call** (OM3.2, `omp-host-tool-error.jsonl`): `{ type: "host_tool_result", id, isError: true, result: { content } }`, with `isError` beside `result`, ends the call `isError: true` with that text.
- **Host tools under `write: deny`** (OM3.4, `omp-host-tool-write-denied.jsonl`, the research preset's table): with `write: deny`, `edit: deny` and `ucch_echo: allow` under `--approval-mode write`, a `write` to `xd://ucch_echo` ran the host tool unasked (the device's own key wins), and a `write` to `notes.md` was refused: `Tool "write" is blocked by user policy.`
- **A host call still running at an abort** (OM3.2, `omp-host-tool-cancel.jsonl`): OMP sends `host_tool_cancel { id, targetId }` (`targetId` is the `host_tool_call`'s `id`) and ends the call itself, `isError: true`, "Aborted: Cancelled". A `host_tool_result` for it sent after that is ignored: no response, no error, and the next command is answered normally. So the host aborts the tool on cancel and may still send its result.
- **Subagents do not see host tools.** A scout's request carried exactly `read, grep, glob, web_search` (its agent definition's tools); `ucch_echo` was not mounted for it. Research workers (`ucch-researcher`, §6.4) therefore cannot rely on host tools; they belong to the parent turn.

### Q4. Compaction summary (§5.1)
- **The summary is on the frame:** `auto_compaction_end.result.summary` (also `shortSummary`, `firstKeptEntryId`, `tokensBefore`, `details.readFiles` / `modifiedFiles`) — `omp-compaction.jsonl:123`.
- **The method and `tokensAfter` are not on the frame.** They are on the session's `compactionSummary` message: `get_messages` → `{ role: "compactionSummary", summary, tokensBefore, tokensAfter, method: "soft" }` — `omp-compaction.jsonl:169`. A divider that shows "142k → 31k" asks `get_messages` (or `get_session_stats` for the after figure) once after `auto_compaction_end`.
- A compaction that would not help ends `{"skipped":true,"errorMessage":"context-full compaction would not reduce context."}` with a `notice` (level `warning`, source `compaction`). Also skipped: a manual `compact` right after an automatic one (`"Already compacted"`). Neither is a divider.
- **Handoff** (RPC `handoff`, `omp-handoff.jsonl:43`) answers `success: true, data: {}`; the brief is the new `compactionSummary` message with `method: "handoff"` (`:45`).
- Manual `compact` streams `manual_compaction_start` / `manual_compaction_end { result }`, and its `response.data` is the same result.

### Q5. Usage, cost and context (§3.4, §5.2)
`get_session_stats` — `omp-plain.jsonl:26`:
```json
{"sessionFile":"…","sessionId":"…","userMessages":1,"assistantMessages":1,"toolCalls":0,"toolResults":0,"totalMessages":2,
 "tokens":{"input":100,"output":10,"reasoning":0,"cacheRead":0,"cacheWrite":0,"total":110},
 "cost":0,"premiumRequests":0,
 "contextUsage":{"tokens":100,"contextWindow":128000,"percent":0.078125}}
```
- Usage and cost are **session totals**, so a turn's figures are the difference from the stats taken before its prompt (§3.4 already says so).
- `context.usage` maps `usedTokens ← contextUsage.tokens`, `windowTokens ← contextUsage.contextWindow`. **There is no threshold field**; `thresholdTokens` comes from UCCH's own overlay (`compaction.thresholdTokens`, or `thresholdPercent × window`) and is null when neither is set.
- Each assistant `message_end` also carries `usage { input, output, cacheRead, cacheWrite, totalTokens, cost { …, total } }`.

### Q6. Subagents (§6.2, §6.5)
- After `set_subagent_subscription { level: "progress" }` (answered `data: { level: "progress" }`):
  - `subagent_lifecycle { payload: { id, agent, parentToolCallId, detached, agentSource, status: "started"|"completed"|…, sessionFile, index } }` — `omp-subagent.jsonl:35`, `:42`;
  - `subagent_progress { payload: { index, agent, agentSource, task, parentToolCallId, detached, assignment, progress: { id, status, recentTools, recentOutput, toolCount, requests, tokens, cost, durationMs, modelRole, resolvedModel, contextWindow, … }, sessionFile } }` — `:37`.
  - The subagent's result text is **not** in the lifecycle frame. It arrives as a `custom` message (`customType: "async-result"`) with `<task-result id=… agent=… status=…><output>…</output></task-result>` (`:46`). `subagent_finished.result` takes it from there.
- **Tasks are background jobs by default** (`async.enabled: true`). The `task` tool returns at once ("Spawned agent `ScoutSrc`"), the turn ends with **`agent_end { isTerminal: false, awaitingAsyncWork: true }`** (`:33`), and a second, terminal `agent_end` follows once the job reports back (`:57`). Rule 4 of §2 (wait for `isTerminal !== false`) is exactly right and load-bearing.
- **Workers are in-process.** Four concurrent scouts: zero child processes of `omp`, 61 threads, 300 MB RSS. The scheduler counts one OMP process per turn; no worker accounting is needed.
- `get_subagents` after the turn returned `[]`.

### Q7. OpenRouter model ids (§3.2)
- **`openrouter/<OpenRouter id>`**, the account's OpenRouter id unchanged: `--model openrouter/anthropic/claude-sonnet-4.5` resolved to `{ provider: "openrouter", id: "anthropic/claude-sonnet-4.5", contextWindow: 1000000 }` in `get_state`.
- `omp models find claude-sonnet` with `OPENROUTER_API_KEY` set lists them under `openrouter`, with per-model thinking levels (e.g. `anthropic/claude-sonnet-4.5`: minimal, low, medium, high). An effort the model lacks is OMP's to map.
- An unknown id fails before `ready` (see OM0.2).

### Other RPC facts found on the way
- **Abort:** `abort` is answered at once, `agent_end` follows within ~20 ms, the last assistant message has `stopReason: "aborted"`, `errorMessage: "Interrupted by user"`. Closing stdin then exits 0.
- **Abort, measured for OM2.4** (`scratchpad/probe/abort.mjs`, `abort2.mjs`, 2026-10-31):
  - During a running tool (`sleep 8`, `--approval-mode yolo`): the tool ends `isError: true`, the assistant message `stopReason: "aborted"`, then terminal `agent_end`, then **`prompt_result { status: "aborted" }`**, then `session_settled`. Closing stdin exits 0.
  - **While an approval is open, `abort` is not answered** (no response in 30 s): OMP's command loop waits on the dialog. Answering the dialog first — `cancelled: true` or `value: "Deny"`, before or after the `abort` — lets it through, and the turn ends as above ("Tool call denied by user: bash", then `prompt_result { status: "aborted" }`). So an interrupt answers every open approval, then sends `abort`.
  - `get_session_stats` on a new session, before any prompt: all `tokens` 0, `cost` 0, `sessionId` set — the "before" figure for a turn's usage.
  - **`get_session_stats` totals carry across `--resume`**: a resumed session starts with the earlier turns' tokens, so a turn's usage is the difference between a call before its prompt and one after.
- **Overlay facts, measured for OM2.5** (2026-10-31):
  - **Tool list:** `omp --tools=zzbogus` prints the binary's list — `fixtures/omp-tools.txt`. A default session sends `read, bash, edit, ask, eval, glob, grep, task, wait, todo, web_search, write` top-level and mounts `ast_edit`, `debug`, `lsp`, `report_issue` as devices (request logs). `browser` and `computer` are not tools in 18.14.1 but eval preludes (`browser.enabled` default **true**, `computer.enabled` false). `wait` runs unasked under `always-ask` (read tier).
  - **Model roles:** the binary's role set is `default, smol, slow, plan, vision, commit`; `advisor.enabled` names an `advisor` role. There is no `task` or `tiny` role. A project `modelRoles.default` is honoured when `--model` is absent (it fell back to `openrouter/openai/gpt-5.5` when the named model did not exist), so the overlay names every role.
  - **A project cannot redirect the key** (`scratchpad/probe/exfil.mjs`, a local capture server, `OPENROUTER_API_KEY=sk-or-CANARY`): `.omp/models.yml`, a root `models.yml` and `providers.openrouter.baseUrl` in `.omp/config.yml` are all ignored — no request reached the capture server, and a provider defined there is "not found". The key went to openrouter.ai, which answered `401 Missing Authentication header` (its text for an invalid bearer; with no header it says "No cookie auth credentials found").
  - **Enums:** `memory.backend` off|local|hindsight|mnemopi|sharpshooter; `mnemopi.scoping` global|per-project|per-project-tagged; `mnemopi.llmMode` none|smol|remote; `providers.cacheWarming` off|streaming|idle.
  - **The writer's YAML read back by OMP:** with the generated overlay as `agent/config.yml`, `omp config list --json` gave every one of its 62 key paths the written value, in the written layer and in the effective settings (`scratchpad/ov/check.mts`).
- **`OmpProvider` end to end** (`scratchpad/e2e/e2e.mts`, real 18.14.1, scripted model via `modelRoles.default`, guard hook loaded, `--no-lsp`): a strict-mode `bash` approval round trip (requested `call_1`, resolved, result, completed, 294 ms); an interrupt at an approval (cancelled, process exited on stdin close without a signal, 238 ms); `--resume` of that session (same `sessionId`); an unknown resume id (`turn_failed` with OMP's "Session … not found", 97 ms).
- **Retries:** an HTTP 503 followed by an answer produced **no** `auto_retry_*` frames (`omp-retry.jsonl`); the provider client retried silently. `agent.retry` will be rare.
- **Errors:** a non-retryable API error ends the turn normally (`agent_end`, terminal) with the assistant message `stopReason: "error"`, `errorMessage: "400 …"`, and `prompt_result { status: "error", error: { message, provider, model, retryable, httpStatus } }` — `omp-error.jsonl:16`. The normaliser fails the turn on that, not on the exit code (which is 0).
- **`prompt_result { id, agentInvoked, status, sessionSettled }`** follows every prompt; `session_settled` follows when background work is done.
- **Noise frames** in every session: `extension_ui_request { method: "setWidget" }`, `advisor_cost_changed`, `available_commands_update`. All ignorable.
- `tool_execution_start.args` omits the model's `i` (intent) field and puts it in `intent`.

---

## OM0.4 — Safety

`node scripts/omp/probe-safety.mjs` plants each source in a scratch repository, wired to leave a marker file when loaded (or a sentinel string in what OMP sends the model), runs `omp -p` under five cumulative configurations, and records what took effect. Each run has its own `HOME` and `PI_CODING_AGENT_DIR`. The overlay in column 4 is `tools.approvalMode: yolo`, `mcp.enableProjectConfig: false`, `skills.enableClaudeProject/enablePiProject/enableAgentsProject: false`, `commands.enableClaudeProject/enableOpencodeProject: false`.

| Plant | defaults | `PI_CONFIG_DIR=.ucch-omp` | + `--no-extensions --no-rules` | + overlay | + `--no-lsp` |
|---|---|---|---|---|---|
| `.omp/config.yml` (`approvalMode`) | LOADED | LOADED | LOADED | – ¹ | – ¹ |
| `.omp/hooks/pre/*.ts` | LOADED | LOADED | – | – | – |
| `.omp/lsp.json` | LOADED | LOADED | LOADED | LOADED | – |
| `lsp.json` (root) | LOADED | LOADED | LOADED | LOADED | – |
| `.omp/dap.json` | LOADED | LOADED | LOADED | LOADED | LOADED ² |
| `dap.json` (root) | LOADED | LOADED | LOADED | LOADED | LOADED ² |
| `.omp/mcp.json` | LOADED | LOADED | LOADED | – | – |
| `.mcp.json` (root) | LOADED | LOADED | LOADED | – | – |
| `.claude/settings.json` MCP server | – | – | – | – | – |
| `.omp/agents/*.md` (listed to the model) | LOADED | LOADED | LOADED ⁴ | LOADED ⁴ | LOADED ⁴ |
| `.omp/RULES.md` | LOADED | LOADED | – | – | – |
| `.claude/skills/*/SKILL.md` | LOADED | LOADED | LOADED | – | – |
| `.omp/skills/*/SKILL.md` | LOADED | LOADED | LOADED | – | – |
| `.claude/commands/*.md` | – ³ | – ³ | – ³ | – ³ | – ³ |
| `AGENTS.md` | LOADED | LOADED | LOADED | LOADED | LOADED |
| `.claude/CLAUDE.md` | LOADED | LOADED | LOADED | LOADED | LOADED |
| *user-scope hook* (`$PI_CODING_AGENT_DIR/hooks/pre/`) | LOADED | LOADED | **–** | – | – |
| *`--hook <abs path>`* | LOADED | LOADED | LOADED | LOADED | LOADED |

¹ The project file is still read; the overlay's own `approvalMode` outranks it. See "project config still loads" below.
² A sixth configuration, the fifth plus `debug.enabled: false` in the overlay, stopped both `dap.json` plants (the debug tool is gone, so no adapter is spawned).
³ `.claude/commands/` did not expand in `-p` under any configuration (the model received the literal `/plantcmd`). Prompt commands only matter interactively; the overlay still sets `commands.enableClaudeProject: false`.
⁴ Listed only. See "custom agents" below.

**What the table says:**
1. **`PI_CONFIG_DIR` does nothing for project scope.** It renames the *user* directory (`~/.omp` → `~/.<name>`; with `PI_CODING_AGENT_DIR` set it has no effect at all). Every project plant loads exactly as without it. Dropped from §0.3 and §3.3.
2. **`--no-extensions` stops project hooks — and user-scope hooks too.** A hook in `$PI_CODING_AGENT_DIR/hooks/pre/` does **not** load under `--no-extensions`. **`--hook <absolute path>` loads under every configuration.** The guard hook (§3.9) is therefore passed with `--hook`, not installed into `hooks/pre/`.
3. **Project LSP config (both `.omp/lsp.json` and root `lsp.json`) loads until `--no-lsp`.** Untrusted projects get `--no-lsp`.
4. **Project MCP (`.omp/mcp.json`, `.mcp.json`) is stopped by `mcp.enableProjectConfig: false`.** Claude's `.claude/settings.json` `mcpServers` is not read by OMP at all.
5. **Project skills are stopped by the `skills.*Project: false` keys** in the overlay; `--no-rules` stops `.omp/RULES.md`.
6. **Project agents (`.omp/agents/*.md`) are listed to the model under every configuration, but under `--no-extensions` they cannot run.** The `task` tool's description lists them (the sentinel in the table), yet a `task` call naming one fails preflight: `Task V1 failed preflight: Unknown agent "ucch-probe". Available: scout, reviewer, security-reviewer, seance, task, sonic.` (a scratch probe, 3 of 3 runs; method in the next table). So a project agent is model-visible description text, like `AGENTS.md`, not a runnable prompt with its own tools. The guard hook still refuses a `task` call whose `tasks[].agent` is not bundled (`scout`, `reviewer`, `security-reviewer`, `sonic`, `task`, `seance`), as defence in depth should a later version change this.
7. **`AGENTS.md` and `.claude/CLAUDE.md` are always read** (`--no-context-files` would stop them). That is the intended behaviour (§3.8).

**Custom agents and `--no-extensions` — the same rule applies to UCCH's own.** Measured with a `task` call naming `ucch-probe` (full frontmatter: `tools`, `thinkingLevel`, `blocking`), 3 runs each:

| Where the agent file is | default flags | `--no-extensions` |
|---|---|---|
| `$HOME/.omp/agent/agents/` | ran (its body reached the worker's request) | **Unknown agent** |
| `$PI_CODING_AGENT_DIR/agents/` (`HOME` elsewhere) | **Unknown agent** ("Searched: ~/.omp/agent/agents") | Unknown agent |
| project `.omp/agents/` | ran outside a git repository; Unknown agent inside one | Unknown agent |

A file with only `name` and `description` was never runnable. `config.yml`, by contrast, *is* read from `$PI_CODING_AGENT_DIR` (`omp config get tools.approvalMode` gave the value from `$PI_CODING_AGENT_DIR/config.yml` with `HOME` elsewhere), so the subject's `agent/config.yml` (OM1.4) works; only `agents/` is fixed to `$HOME`. So **UCCH cannot ship `ucch-*` agent files** while it runs `--no-extensions`, and `PI_CODING_AGENT_DIR` does not move the agents directory. §6.4 is corrected: UCCH's roles (verifier, researcher) are the bundled `task` agent with the role's instructions in `context` and a JSON reply format in the task text, parsed by UCCH; the bundled `reviewer` already has structured output (OM0.5 Q3).

**Project config still loads, and records merge into the overlay.** There is no setting or flag that stops `.omp/config.yml` being read. Measured under `--no-extensions --no-rules --no-lsp --config <overlay> --approval-mode always-ask`:

| Project `.omp/config.yml` | Effect |
|---|---|
| `tools.approvalMode: yolo` | none: `--approval-mode` (a runtime flag) outranks project config; `bash` still asked |
| `tools.approval.bash: allow` | **`bash` ran without asking.** `tools.approval` is a record, records deep-merge, and the overlay did not name `bash` |
| the same, with the overlay setting `tools.approval.bash: prompt` | asked again: the overlay wins for every key it names |
| `extensions: [./.omp/evil.ts]` | not loaded under `--no-extensions` |

So **the overlay must name every tool that can do harm in `tools.approval`**, per permission mode (`prompt` for what the mode asks for, `allow` for what it runs, `deny` for what is off), not only the denies; otherwise a cloned repository relaxes the gate. OM2.5's overlay writer does that, and the guard hook (passed with `--hook`) repeats the hard rules, so a key the overlay misses still cannot push, commit, or write outside the worktree.

**The guard hook can see and block what §3.9 and §8.3 need.** A `--hook` module under `--no-extensions --approval-mode yolo` received `tool_call` events `{ toolName: "bash", input: { command: "git push origin main" } }` and `{ toolName: "write", input: { path: "xd://debug", content: "{\"action\":\"attach\",\"pid\":1}" } }`, and returning `{ block: true, reason }` ended each call with `isError: true` and that reason as the result text. A debugger attach is therefore visible to the hook as a `write` to `xd://debug` whose JSON `content` holds `pid`.

**Minimal flag set for an untrusted project:**
```
omp --mode rpc-ui --approval-mode <mode> --no-extensions --no-rules --no-lsp \
    --hook <abs>/ucch-guard.ts --config <overlay>
```
with an overlay that sets `mcp.enableProjectConfig: false`; `skills.enableClaudeProject`, `skills.enablePiProject`, `skills.enableAgentsProject: false`; `commands.enableClaudeProject`, `commands.enableOpencodeProject: false`; `debug.enabled: false` (no DAP for untrusted projects: footnote ²); and the full `tools.approval` table. A trusted project drops `--no-lsp` and `debug.enabled: false`.

---

## OM0.5 — Bridge and CLI questions

### Q1. Claude Code with `--mcp-config` — works
```
claude -p --output-format stream-json --verbose --input-format stream-json \
  --permission-mode acceptEdits --permission-prompt-tool stdio --setting-sources user \
  --mcp-config mcp.json --strict-mcp-config --model haiku          (Claude Code 2.1.314)
```
with `mcp.json` = `{"mcpServers":{"probe":{"command":"node","args":["…/mcp-ping.mjs"],"env":{"PROBE_ENV":"from-mcp-json","OPENROUTER_API_KEY":"sk-or-dummy"}}}}` and a hand-written stdio MCP server with one tool, `ping`:
- `system/init`: `tools` includes `mcp__probe__ping`; `mcp_servers: [{"name":"probe","status":"connected","source":"dynamic"}]`.
- The CLI first used its tool search (a `tool_result` of `[{"type":"tool_reference","tool_name":"mcp__probe__ping"}]`), then asked permission:
  ```json
  {"type":"control_request","request_id":"c3e3…","request":{"subtype":"can_use_tool","tool_name":"mcp__probe__ping","mcp_server":{"name":"probe","source":"dynamic"},"display_name":"Ping","input":{},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"mcp__probe__ping"}],"behavior":"allow","destination":"localSettings"}],"server_policy_ask_only":true,"tool_use_id":"toolu_01Lz…"}}
  ```
  This is the same `can_use_tool` shape `ClaudeNormaliser` already handles, plus `mcp_server` and `display_name`.
- After `allow`, the result was `pong env=from-mcp-json key=set`: the MCP JSON's `env` reaches the server, and the CLI's own environment had no key. The design in §10.3 holds.

### Q2. Codex `-c mcp_servers.…` — syntax confirmed, runtime blocked
- Codex is not installed on the dev machine or in the image. `@openai/codex@0.166.0` was installed into a scratch directory to read its help and config handling.
- `-c, --config <key=value>`: "a dotted path (`foo.bar.baz`) … The value portion is parsed as TOML."
- **The syntax works:**
  ```
  codex -c 'mcp_servers.omp.command="node"' -c 'mcp_servers.omp.args=["/abs/omp-bridge.mjs"]' \
        -c 'mcp_servers.omp.env.PROBE_ENV="x"' mcp list
  Name  Command  Args              Env              Cwd  Status   Auth
  omp   node     /abs/omp-bridge…  PROBE_ENV=*****  -    enabled  Unsupported
  ```
  The `[mcp_servers.omp]` `config.toml` fallback in §10.3 is not needed for registration.
- `codex exec --help` describes `--sandbox` as the policy "when executing model-generated shell commands"; MCP servers are not model-generated shell commands.
> BLOCKED (part): whether `codex exec` calls the tool, and whether the server gets network under `workspace-write`, needs a logged-in Codex. Re-check in OM6.5 on a machine with a Codex login.

### Q3. `/review` in `-p --mode json` — not structured at the top level; structured in the reviewer
- `omp -p --mode json "/review"` expands to a prompt ("## Code Review Request … Mode: headless review request. Distribution: Use `task` with a `tasks` array. Set `agent: "reviewer"` … Create exactly 1 reviewer task"), and the JSON stream is the ordinary event stream (`session`, `agent_start`, `message_*`, `turn_end`, `agent_end`). No findings frame.
- **Without `--wait-async` the process exits before the reviewer runs** (tasks are background jobs). With `--wait-async` the reviewer subagent ran (tools `read, grep, glob, bash, web_search, task, wait`).
- **The bundled `reviewer` agent has a structured `output`:** `overall_correctness: "correct"|"incorrect"`, `explanation`, `confidence`, and optional `findings[] { title, body, priority (0–3), confidence, file_path, line_start, line_end }`, delivered with incremental `yield` calls. That is exactly §9.2's `ReviewFinding` / `ReviewVerdict`.
- So §9.2's first branch, through the reviewer's result: UCCH runs `/review` (or a prompt naming the `reviewer` agent) in RPC mode, waits for the terminal `agent_end`, and parses the reviewer's structured result from the `async-result` / `get_subagents` output. A separate `ucch-reviewer` is not needed. Confirming the exact place the structured payload lands needs a real model (a scripted model cannot produce `yield` calls), so OM7.7 records one fixture with a cheap OpenRouter model.

### Q3b. Slash commands in `-p` — no
`omp -p "/memory stats"`, with `memory.backend: mnemopi`, sent the literal text `/memory stats` to the model (4 runs, 4 model requests). Only prompt-template commands such as `/review` expand in `-p`. The memory card (OM7.3) reads the mnemopi SQLite file instead.

### Q4. Non-interactive import from Claude Code or Codex — no
- `omp --from-claude --mode rpc` → `Error: --from-claude is not supported in rpc mode`.
- `omp --from-claude -p "hi"` with a Claude session present drew the interactive picker on the terminal and exited without importing.
- Cross-provider handoff therefore uses the brief (§5.4) for every target, as designed.

### Q5. mnemopi project key — the cwd, so not stable across worktrees
- Read from the 18.14.1 bundle: a `per-project` bank is named `<basename(cwd)>-<Bun.hash(path.resolve(cwd))>`. Measured: `omp -p` in `…/wt1` and `…/wt2` created `memories/mnemopi/banks/wt1-3msruxqw1jbzf/` and `banks/wt2-2mndclts9gik8/`. Two thread worktrees of one project get **two banks**.
- `scoping: global` with `bank: <name>` wrote to the one root `memories/mnemopi/mnemopi.db` for both worktrees, but the bank name does not choose a file. Other projects of the same subject would share it.
- **What works: `scoping: global` plus a per-project `mnemopi.dbPath`.** Three runs with `dbPath: …/mem/projA/mnemopi.db` (wt1, wt2) and `…/mem/projB/mnemopi.db` (wt1) created exactly `projA/mnemopi.db` and `projB/mnemopi.db`, and nothing under the agent's own `memories/`. The overlay sets `mnemopi.dbPath: <CREDS_ROOT>/<subject>/omp/memories/<projectId>/mnemopi.db`. No symlink and no stable `--cwd` is needed (§7.1 corrected). Recall across those processes is OM7.1's acceptance test.

---

## OM0.6 — Measurements

`node scripts/omp/measure-rss.mjs --runs 5 --lsp-bin <dir with typescript-language-server 4.3.4 + typescript 5.7.3>` on the dev machine (16 cores, 15 GB, Linux 7.0). `omp --mode rpc --no-session` against the scripted model; RSS and PSS summed over `omp` and its descendants, sampled every 100 ms, peak reported; medians of 5 runs. Raw data: [`../perf/omp-rss-2026-10-31.json`](../perf/omp-rss-2026-10-31.json).

| Case | Start to `ready` | Peak RSS (omp tree) | Peak PSS | Processes |
|---|---|---|---|---|
| idle `omp --mode rpc` | 317 ms | 274 MB (max 285) | 226 MB | 1 |
| busy: one turn reading 20 files of this repository | 317 ms | 270 MB (max 283) | 219 MB | 1 |
| 4 scouts running at once | 334 ms | 318 MB (max 321) | 266 MB | 1 |
| `typescript-language-server` on this repository (`lsp` diagnostics on `run.ts`) | 339 ms | 1 169 MB (max 1 174) | 863 MB | 7 |
| the language servers alone (the `lsp` case, its LSP processes only) | — | 725 MB | — | 6 |

**Reading it:**
- **Startup is ~0.3 s**, well under the 1 s §3.6 assumed. One process per turn stands; no warm pool (§13: only above 2 s p95).
- **An OMP turn is ~270–320 MB RSS, ~220–270 MB PSS**, against 372 MB for a Claude Code turn (`../plan.md`, measured). Four in-process scouts add ~45 MB.
- **A TypeScript language server on this repository costs ~725 MB** (typescript-language-server + tsserver + typings installer, 6 processes, all children of `omp`), and `omp` itself grows to ~445 MB beside it. Together ~1.17 GB, about 3.6 plain turns' worth.
- **The language servers do not outlive the turn.** They were gone ~3.1 s after `omp` exited, in every run, even with `lsp.shared: true`. With one OMP process per turn, the shared daemon gives nothing across turns, only between turns running at the same time in one project. §8.2's "what makes LSP affordable" does not hold: every LSP turn pays the cold start and the 725 MB.

**Proposed `OMP_TURN_TOTAL` for the 8 GB box: 6.** The plan leaves ~5.9 GB beside the fixed costs, of which the CLI cap (`AGENT_MAX_CONCURRENT_TOTAL=5` × ~400 MB) gives agent processes ~2 GB. Six OMP turns at the measured peak with scouts (321 MB) is 1.93 GB. OMP turns take the CLI slots' place, not extra room: the per-account cap (`cliPerUser: 2`) covers them too.

LSP changes that budget. Untrusted projects run `--no-lsp` anyway (OM0.4). For trusted projects, OM7.4 must either count an LSP turn as 4 OMP slots or cap LSP turns separately (one at a time on 8 GB). Language servers stay off until then.

---

## Measured later, during the tasks

Each with 18.14.1, against the scripted model (`scripts/omp/scripted-model.mjs`) in a throwaway `HOME`, unless it says otherwise.

- **`compaction.thresholdPercent`** (OM4.2), read from the binary: a value of 0 or below means unset; otherwise it is clamped to 1-99 and the threshold is `floor(window × percent / 100)`. `thresholdTokens` overrides it when set. Both default to -1.
- **`omp -p` text mode** (OM4.4): exit 0, the answer alone on stdout (with a trailing newline), `Working...` on stderr. An error exits 1 with the message on stderr and nothing on stdout.
- **`omp -p` reads stdin** (OM4.4): the piped text is put ahead of the prompt argument in the one user message (`<stdin>\n\n<prompt>`), so a long transcript goes on stdin, clear of Linux's 128 KiB limit on a single argument.
- **`--model @smol`** (OM4.4): takes the `smol` role of the config, the overlay included (`--config`); a name that resolves to nothing fails with `Model "…" not found`.
- **`--no-tools`** (OM4.4): the request carries an empty `tools` array.
- **`task.maxConcurrency`** (OM5.4): with UCCH's own overlay (`ompOverlay`, `workersPerTurn: 4`, under `--no-extensions --no-rules --no-lsp`), one `task` call of 10 scouts, each model reply taking 1.5 s, ran them in waves of 4, 4 and 2: `subagent_lifecycle` never showed more than 4 started and not yet completed. The same run with `workersPerTurn: 10` had all 10 running at once, so the overlay's value is what holds it. Under the default permission mode `task` asks first (`Allow tool: task … Batch agents: scout ×10`), once for the whole batch.
- **Isolated workers** (OM5.5): with `task.isolation.enabled: true` (apply on, `merge: patch`) and `isolated: true` per task, in a git checkout, each worker's `async-result` adds `<merge-summary>Applied patches: yes</merge-summary>` and "ran isolated and cannot be resumed or messaged". Two workers writing different files: both files land in the checkout. Two writing the same line: the first applies; the second still reports `status="completed"`, with a merge summary of `&lt;system-notification>Patches were not applied and must be handled manually.&lt;/system-notification>` and the path of a `.patch` artifact in its session directory. Its lifecycle frame says `completed` too.

- **The bridge's calls** (OM6.2), each through the bridge's own `runOmpCall` with its argv (`--mode rpc --no-session --approval-mode yolo --tools … --no-extensions --no-rules`):
  - `--tools ast_grep,…` exits 2 before `ready`: `Built-in tool unavailable in this session: ast_grep.` (`astGrep.enabled` defaults to false). `--tools recall,retain` without memory: `Built-in tools unavailable in this session: recall, retain.`
  - Under `--tools`, `lsp`, `ast_edit` and `debug` are top-level tools (no `xd://` section in the system prompt). `lsp` actions: `diagnostics, definition, references, hover, symbols, rename, rename_file, code_actions, type_definition, implementation, status, reload, capabilities, request`.
  - With typescript-language-server 4.3.4 on `PATH` and a `tsconfig.json` at the root: `rename` with `apply: false` answered "Rename preview: src/a.ts: 1 edit, src/b.ts: 2 edits" and changed nothing; without `apply` it applied both files. Without a root marker: "No language server found for this action".
  - `ast_edit` staged its rewrite ("Staged as a proposal — files NOT modified yet. To apply: write a one-sentence reason to xd://resolve"); a `write` to `xd://resolve` applied it. With no `write` tool, the turn failed: `Soft tool requirement 'write' was not satisfied after 3 forced turns`. With `write` offered and `tools.approval.write: deny`, a write to `xd://reject` was blocked by the same policy. An `abort` after the `ast_edit` result ended the turn at once, unapplied (`omp-bridge-codemod.jsonl`).
  - Memory: `retain` (items `{ content, context?, scope: project|global }`) wrote to the overlay's `mnemopi.dbPath`; a second process's `recall` found the entry there. With `llmMode: none` the match is lexical ("pnpm" found it, "package manager" did not).
  - Under `--no-extensions`, a prompt of `/review` reached the model as the literal text `/review`.

- **Codex and an MCP server** (OM6.5), `@openai/codex@0.166.0` in a scratch directory, with no login: `codex exec` was pointed at a scripted Responses API through a custom provider (`-c model_provider=…`, `-c model_providers.<id>={base_url, wire_api="responses", env_key}`), so the model side is fixed and nothing is billed. The MCP side is what a subscription run does.
  - The server's tools reach the model as one `namespace` tool, `mcp__omp`, holding the server's functions. A call is a `function_call` with `namespace: "mcp__omp"` and `name: "omp_task"`. In the JSON stream it is an `mcp_tool_call` item (`server`, `tool`, `arguments`, `result`, `status`), which `CodexNormaliser` already maps.
  - **A tool not marked read-only is refused in `exec`:** `"MCP tool call requires approval, but approval policy is never"`. A `readOnlyHint` tool runs. `mcp_servers.<id>.default_tools_approval_mode` takes `auto`, `prompt`, `writes` or `approve`, and with `approve` every bridge tool runs. Per-tool overrides use `mcp_servers.<id>.tools.<tool>.approval_mode`.
  - The server's environment is `HOME`, `PATH` and the configured `env` (and `env_vars`, a list of names forwarded from Codex's own). Nothing else is inherited.
  - The server is not sandboxed: under `--sandbox workspace-write` it reached a TCP port on 127.0.0.1, and the bridge reached the scheduler's Unix socket. The real bridge ran `omp_task` scout end to end on real OMP.
  - `tool_timeout_sec` and `startup_timeout_sec` are per-server keys (`codex mcp get --json` shows them).

- **mnemopi across worktrees** (OM7.1), `omp -p` under `writeOmpOverlay` with memory on, `scoping: global` and `dbPath` per project. In project A's first worktree the model called `retain` ("1 memory stored."). Auto-recall then put the fact into the first request of a run in A's second worktree, and not into one in project B. Only `memories/projA/mnemopi.db` and `memories/projB/mnemopi.db` were created. With `noEmbeddings: false` the first run fetched 770 MB into HOME (`.omp/cache/fastembed` with `Qdrant_bge-base-en-v1.5-onnx-Q` at 209 MB, `fastembed-runtime` at 328 MB, `.bun/install/cache` at 233 MB). With `noEmbeddings: true` nothing was fetched, and recall needed shared words: "Work on the deploy." missed the fact and "Which Fly.io region do deploys go to?" found it, under both `llmMode: none` and `smol`.
- **What a bridge call can reach beyond `--tools`** (OM6.8), through the bridge's `omp_task` with the scripted model playing the subagent, and through the README's recipe (Claude Code 2.1.316 with the bridge added at user scope, no UCCH overlay):
  - `--tools` limits the session, not its subagents. Under `--tools read,grep,glob,task`: a scout got `read, grep, glob, web_search` (`read, find, grep, glob, web_search` in the recipe); a reviewer `read, grep, glob, bash, web_search, task, wait`; a sonic (`…,edit,write`) `read, bash, edit, eval, glob, grep, task, wait, web_search, write`. A reviewer's `bash` ran (`echo … > file` wrote the file).
  - A second `--config` ranks above the first. `tools.approval.bash: deny` in it refused the reviewer's `bash` (`Tool "bash" is blocked by user policy.`), with `bash` still in the request's schema. `web_search.enabled: false` in it took `web_search` out of the scout's tools.
  - With no `dev.autoqa: false`, each session also got a `write` tool for `xd://report_issue`, OMP's tool QA, which may send reports to `https://qa.omp.sh/v1/grievances` (default on; the first report asks for consent). `write` reaches only `xd://` devices and `local://` files, not the worktree.
  - OMP's sources for other agents' configuration (`cursor, codex, claude, claude-plugins, gemini, opencode, windsurf, github`) are opt-in, but the binary enables `claude` whenever `CLAUDE_CONFIG_DIR` is set. In the recipe, the bridge's OMP then mounted the Claude Code config's own `omp` server as `xd://mcp__omp_task` and the rest. An OMP turn under `ompOverlay` with `CLAUDE_CONFIG_DIR` pointing at a config with one MCP server mounted `xd://mcp__demo_omp_probe`. `disabledProviders` is checked before every opt-in, and with all eight listed, neither run mounted anything.

## Corrections made to `solution.md`

| Section | Was | Now |
|---|---|---|
| §0.3 table, §3.3 | `PI_CONFIG_DIR=.ucch-omp` renames project `.omp/` | it does not; dropped. Controls are the flags, the overlay and the guard hook |
| §0.3 | project config is outranked by the overlay | true only for keys the overlay names; `tools.approval` records merge, so the overlay names every tool |
| §0.3 | `.omp/agents/` stopped by flags | listed to the model always, runnable never under `--no-extensions`; the guard hook allows only bundled agents |
| §0.3, §8.2 | `--no-lsp` "if required" | required for untrusted projects (both LSP config files load otherwise) |
| §0.3, §8.3 | DAP: project `dap.json` not used | both `dap.json` files load under every flag; `debug.enabled: false` for untrusted projects |
| §1.1 | route (a) or (b) | route (b): the GitHub release asset with SHA-256; plus `PI_NATIVES_DIR` |
| §3.1 | `--resume` (verify) | works in RPC mode with `--session-dir`; an unknown id exits 1 before `ready` |
| §3.1 | `--hook` not in argv | `--hook <abs>/ucch-guard.ts` always |
| §3.4 | session id from `session_info_update` or `get_state` | from `get_state` after `ready` |
| §3.4 | `extension_ui_request` `confirm` → permission | `select` with `title: "Allow tool: …"` |
| §3.4 | host tools: UCCH emits tool events unless OMP does | OMP does; UCCH emits none. `write` to `xd://<tool>` maps back to `<tool>` |
| §3.5 | answer with `confirmed: true/false` | answer with `value: "Approve" / "Deny"` |
| §3.7 | schema format (verify) | JSON Schema; tools mounted as `xd://` devices; tier `exec`; not visible to subagents |
| §3.9 | hook installed into `agent/hooks/pre/` | passed with `--hook`; `hooks/pre/` does not load under `--no-extensions` |
| §4 | `enableClaudeProject`, `enableCodexProject` | `skills.enableClaudeProject`, `skills.enablePiProject`, `skills.enableAgentsProject`, `commands.enableClaudeProject`, `commands.enableOpencodeProject`, `mcp.enableProjectConfig` (there is no `enableCodexProject`) |
| §4 | `task.isolation.mode` | `task.isolation.enabled` (boolean; per task `isolated: true`) |
| §4 | `mnemopi.scoping: per-project` | `scoping: global` + `dbPath` per project |
| §5.1 | summary from the frame, or `get_messages_page` | `result.summary` on the frame; method and `tokensAfter` from `get_messages` |
| §5.2 | `thresholdTokens` from `get_session_stats` | stats give `contextUsage.{tokens, contextWindow}`; the threshold is UCCH's own setting |
| §6.2 | lifecycle field names (verify) | as in Q6 above; the result text comes from the `async-result` message |
| §6.4 | `ucch-*` agent files in the subject's `agent/agents/` | custom agents do not run under `--no-extensions`, and `PI_CODING_AGENT_DIR` does not move `agents/`; UCCH roles use the bundled `task` agent with instructions in `context` (frontmatter would be `thinkingLevel`, JTD `output`, for the record) |
| §6.5 | workers may be subprocesses | in-process |
| §7.1 | symlink + `--cwd` | `dbPath` |
| §7.3 | `omp -p "/memory stats"` | slash commands do not run in `-p`; read the SQLite file |
| §9.2 | structured `--mode json`, or `ucch-reviewer` | the bundled `reviewer`'s structured output; no `ucch-reviewer` |
| §10.3 Codex | `-c` syntax (verify) | confirmed for registration and, in OM6.5, at runtime (scripted provider, no login) |
| §10.3 Codex (OM6.5) | the key in `-c mcp_servers.omp.env.…` | argv is world-readable in `ps`: the env goes in a 0600 file named by `UCCH_BRIDGE_ENV_FILE`; plus `default_tools_approval_mode="approve"` (exec refuses unapproved tools) and `tool_timeout_sec` |
| §4, §7.1 (OM7.1) | `noEmbeddings: false` | `true`: embeddings download ~770 MB at runtime |
| §10.2 (OM6.8) | "the allowlist is the real control" | `--tools` does not bound subagents: each call adds a guard `--config` that denies every unnamed tool, turns off `dev.autoqa` and `web_search`, and disables other agents' config sources; the turn overlay (§4) gains `disabledProviders` |
| §10.2 (OM6.2) | `omp_codemod` `--tools ast_grep,ast_edit,read`; recall/retain on `@tiny`; `omp_review` runs `/review` | `ast_edit,read` (+`write`), the preview aborted after `ast_edit`; `@smol`; the headless review request with the diff |

## Blocked

- **OM0.5 Q2, runtime half:** settled in OM6.5 without a login (see "Measured later"). Only the subscription's own auth path is unexercised, and the MCP server does not touch it.
- **Recorded with a real OpenRouter model:** nothing. A cheap-model recording is still useful for two things the scripted model cannot do: the reviewer's `yield` payload (OM7.7) and an `auto_retry_*` sequence, if OMP ever emits one. Both are noted at the task that needs them.
