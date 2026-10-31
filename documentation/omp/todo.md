# UCCH × OMP: agent task list

**Why:** [`plan.md`](./plan.md) · **Design:** [`solution.md`](./solution.md) · This file is *what to do*, in order.

The performance task list ([`../todo.md`](../todo.md), PF tasks) is separate and stays live. Where a task here depends on one there, it says so.

## How to use this file (read first)

1. **Pick a task.** Take the lowest-numbered unchecked task in the earliest phase whose **Depends** are all checked. Don't start a task whose dependencies are open. Phases OM4, OM5 and OM6 only depend on OM2, so they may run in parallel on separate branches.
2. **Read before writing.** Read every file under **Files**, and the `solution.md` section the task cites. Read the OMP doc page the section links, too. Many tasks reuse existing code; the task names it.
3. **Never guess OMP behaviour.** Anything marked **(verify in OM0)** in `solution.md` must have an answer in `documentation/omp/spike-report.md` before you write code that relies on it. If the report contradicts `solution.md`, update `solution.md` in the same commit and say so in the message.
4. **Stay in scope.** One task is one coherent change. Don't refactor neighbouring code, rename unrelated things or reformat files.
5. **Follow the conventions:**
   - `apps/web/CLAUDE.md`: skeletons not spinners, `TransitionLink` / `useTransitionRouter` only, layouts await nothing, a `loading.tsx` per route.
   - Match the surrounding code's comment density and naming. Server modules use `#private` fields and explanatory block comments. Provider modules explain load-bearing flags in a block comment, as `claude.ts` does for `--bare`.
   - Tests sit next to the code (`*.test.ts`) and run with vitest from the repo root. Provider tests use recorded JSONL fixtures and `packages/providers/src/testing.ts`.
6. **Billing safety is a test, not a comment.** Any task that builds an environment for a process adds or extends a test that a forbidden credential variable makes the run refuse to start (solution §0.1).
7. **Verify.** Run every command under **Verify**. A task is done only when they all pass *and* every **Acceptance** bullet holds.
8. **Record it.** Change `[ ]` to `[x]` and add ` — <commit sha>` after the title. Commit messages end with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
9. **If blocked:** leave the task unchecked and add a `> BLOCKED:` line under it saying why. Then move to another task with no dependency on it.

Standard verification, for any task that touches code:

```bash
pnpm typecheck && pnpm test
# web tasks also need a production build
pnpm --filter @ucch/web build
```

---

## Phase OM0: Spike, fixtures and answers

The output of this phase is knowledge, not product code: `documentation/omp/spike-report.md`, recorded fixtures, and measured numbers. Use a cheap OpenRouter model throughout and record its id in the report.

- [x] **OM0.1 — Install and pin OMP** — 83c953e

  - **Depends:** —
  - **Files:** new `documentation/omp/spike-report.md`
  - **Steps:**
    1. Install on the dev machine: `curl -fsSL https://omp.sh/install | sh`, then `omp --version` ([quickstart](https://omp.sh/docs/quickstart)).
    2. Read the install script. Record whether it can install a **specific version** into a **chosen directory**, and whether the result is self-contained or needs Bun. This answers plan §9 Q8.
    3. Pick the version to pin. Record it, its release URL and its SHA-256.
    4. In a disposable `OMP_PROFILE`, record `omp --help` and `omp config list --json` to `packages/providers/src/fixtures/omp-help.txt` and `omp-config-list.json`.
  - **Acceptance:** the report names the version, the install route for the image, and the runtime dependencies.
  - **Verify:** `omp --version` prints the pinned version
- [x] **OM0.2 — RPC transcripts for the provider** — 83c953e

  - **Depends:** OM0.1
  - **Files:** new `scripts/omp/record-rpc.mjs`, new `packages/providers/src/fixtures/omp-*.jsonl`
  - **Steps:**
    1. `record-rpc.mjs` spawns `omp --mode rpc-ui --no-session …`. It writes each stdin line and stdout frame with a direction tag, and replaces secrets with `<redacted>`.
    2. Record these fixtures:
       - `omp-plain` (a one-line answer)
       - `omp-tool` (read, then edit a file)
       - `omp-confirm` (approval mode `write`, a `bash` call)
       - `omp-compaction` (a low `compaction.thresholdTokens` to force it)
       - `omp-handoff` (the RPC `handoff` command)
       - `omp-subagent` (`set_subagent_subscription progress`, then a scout task)
       - `omp-host-tool` (`set_host_tools` with one echo tool)
       - `omp-error` (an invalid model)
    3. Do it once with `negotiate_protocol` v2 and confirm `rpc_chunk` appears for a large read.
  - **Acceptance:** all eight fixtures exist and contain a terminal `agent_end` (or the error).
  - **Verify:** `node scripts/omp/record-rpc.mjs --check` re-parses every fixture
- [x] **OM0.3 — Answer the RPC questions** — 83c953e

  - **Depends:** OM0.2
  - **Files:** `documentation/omp/spike-report.md`
  - **Steps:** for each question, write the answer and the fixture line that shows it.
    1. How is the session id reported (`get_state`, `session_info_update`)? Does `--resume <id>` work with `--mode rpc` and `--session-dir`, or is `switch_session` needed? (solution §3.1)
    2. Does `rpc-ui` emit `extension_ui_request` `confirm` for approvals? What is the payload, and how is it tied to the tool call? (§3.5)
    3. What are the `set_host_tools` schema format and the `host_tool_call` fields? Does a host tool also produce `tool_execution_*`? Can subagents see host tools? (§3.7)
    4. Where is the summary text after `auto_compaction_end`? (§5.1)
    5. What are the `get_session_stats` fields for usage, cost and context window? (§3.4, §5.2)
    6. What are the `subagent_lifecycle` / `subagent_progress` fields? Are workers in-process or subprocesses? (§6.2, §6.5)
    7. What is the OpenRouter model id syntax, from `get_available_models`? (§3.2)
  - **Acceptance:** every RPC question in solution §2–§6 marked **(verify in OM0)** has an answer.
  - **Verify:** review the report against the solution's markers (`grep -n "verify in OM0" documentation/omp/solution.md`)
- [x] **OM0.4 — Answer the safety questions** — 83c953e

  - **Depends:** OM0.1
  - **Files:** `documentation/omp/spike-report.md`
  - **Steps:** in a scratch git repo, plant one of each of these:

    - `.omp/config.yml` with `tools.approvalMode: yolo`
    - `.omp/hooks/pre/x.ts`, which writes a marker file
    - `.omp/lsp.json` and root `lsp.json` with a marker `command`
    - `.omp/dap.json`
    - `.omp/mcp.json` and `.mcp.json` with a marker server
    - `.claude/settings.json` with an MCP server
    - `.omp/agents/evil.md`
    - `.claude/skills/x/SKILL.md`

    Run `omp -p "hi"` under each of these, and record which plants took effect:

    1. Defaults.
    2. `PI_CONFIG_DIR=.ucch-omp`.
    3. Plus `--no-extensions --no-rules`.
    4. Plus the §4 overlay with project skill providers off.
    5. Plus `--no-lsp`.

    Also check that a user-scope hook under `PI_CODING_AGENT_DIR/hooks/pre/` still loads with `--no-extensions`, and that `--hook <abs>` does.
  - **Acceptance:** a table of plant × configuration → loaded / not loaded, and the minimal flag set for untrusted projects. Update solution §0.3 to match.
  - **Verify:** the marker files exist only where the table says "loaded"
- [x] **OM0.5 — Bridge and CLI questions** — 83c953e

  - **Depends:** OM0.1
  - **Files:** `documentation/omp/spike-report.md`
  - **Steps:**
    1. Claude Code: `claude -p --mcp-config x.json --strict-mcp-config --setting-sources user` with a trivial stdio MCP server. Confirm the tool is listed and callable, and record its permission-prompt shape over `--permission-prompt-tool stdio`.
    2. Codex: find the `codex exec -c mcp_servers.<name>.…` syntax that works, or fall back to `config.toml`. Check whether the MCP server runs outside the `workspace-write` sandbox and has network.
    3. Does `omp -p "/review"` with `--mode json` give structured findings? Do `/memory stats` and other slash commands work in `-p`? (plan §9 Q7, solution §7.3, §9.2)
    4. Is there a non-interactive `--from-claude` / `--from-codex` import? (§5.4)
    5. How does mnemopi key the project? Is it stable across two worktrees of one repository? (§7.1)
  - **Acceptance:** each question has an answer, and the solution sections are updated where the answer differs.
  - **Verify:** the commands and outputs are pasted in the report
  > BLOCKED (part): Q2's runtime half (does `codex exec` call the MCP tool, and does the server have network under `workspace-write`) needs a logged-in Codex. Syntax is confirmed; the runtime check moves to OM6.5.
- [x] **OM0.6 — Measure** — 83c953e

  - **Depends:** OM0.2
  - **Files:** `documentation/omp/spike-report.md`, new `documentation/perf/omp-rss-<date>.json`
  - **Steps:**
    1. Measure RSS (PSS where available) and startup time to `ready` for each of these, 5 runs each:
       - an idle `omp --mode rpc`
       - a busy one (reading 20 files)
       - one with 4 scouts running
       - one with `typescript-language-server` started on this repository
       - the LSP daemon on its own
    2. Compare with the 372 MB Claude Code figure in `../plan.md`.
  - **Acceptance:** numbers for all five cases, plus a proposed `OMP_TURN_TOTAL` for 8 GB.
  - **Verify:** the JSON is committed

---

## Phase OM1: Protocol, config, credentials

- [x] **OM1.1 — `omp` in the provider enums** — d17cb84

  - **Depends:** OM0.3
  - **Files:** `packages/protocol/src/events.ts` (lines 269–274), `packages/providers/src/registry.ts`, `apps/server/src/agent.ts` (`resolveProvider`, line 145), every exhaustive `switch` over `ProviderId` (`grep -rn "ProviderId" apps packages`)
  - **Steps:**
    1. Add `"omp"` to `ProviderId` and `CliProviderId`.
    2. `PROVIDER_LABELS.omp = "Custom"` and `native` becomes "Custom (legacy)". `isCliProviderId` includes `omp`.
    3. `resolveProvider` knows `omp`. The `OMP_ENABLED` rule waits for OM2.7.
  - **Acceptance:** typecheck passes with `omp` unhandled only where the provider is looked up (`ProviderService.provider` returns null for it until OM2).
  - **Verify:** `pnpm typecheck && pnpm test`
- [x] **OM1.2 — Config keys** — 468e3e0

  - **Depends:** OM1.1
  - **Files:** `apps/server/src/config.ts`, `.env.example`, `.env.development.example`
  - **Steps:** add `OMP_BIN`, `OMP_ENABLED` (false), `NATIVE_LOOP_FALLBACK` (true), `OMP_BRIDGE_BIN`, `OMP_TURN_TOTAL` (from OM0.6), `OMP_WORKERS_PER_TURN` (4) and `OMP_BRIDGE_MAX_SECONDS` (300). See solution §1.3.
  - **Acceptance:** each key has a block comment saying what it does and why its default is what it is.
  - **Verify:** `pnpm typecheck && pnpm test -- config`
- [x] **OM1.3 — Per-provider credential rules** — c31d064

  - **Depends:** OM1.1
  - **Files:** `packages/providers/src/types.ts`, new `packages/providers/src/omp-credentials.ts` and its test, `packages/providers/src/run.ts`
  - **Steps:** add `ALLOWED_CREDENTIAL_ENV` and `forbiddenEnvFor(id, env)` (solution §12.2), built on a constant list of OMP credential variables from [env](https://omp.sh/docs/env). Claude and Codex behave as today.
  - **Acceptance:**
    - Tests: `OPENROUTER_API_KEY` is allowed for omp.
    - `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_CODEX_OAUTH_TOKEN` and `GEMINI_API_KEY` each make an omp run refuse.
    - The claude and codex behaviour is unchanged (the existing tests pass).
  - **Verify:** `pnpm test -- providers`
- [x] **OM1.4 — The OMP credential directory** — 7d20078

  - **Depends:** OM1.3, OM0.4
  - **Files:** `apps/server/src/providers.ts` (`credsDir`, `ensureCredsDir`, `providerEnv`), new `packages/providers/assets/omp-hooks/ucch-guard.ts`, new `packages/providers/assets/omp-agents/*.md`
  - **Steps:**
    1. `ensureCredsDir("omp")` creates `agent/`, `sessions/`, `run/` and `wt/` with mode 0700.
    2. It installs the guard hook (solution §3.9) and the UCCH agents (§6.4), refreshed when their content hash changes.
       *(OM0: custom agent files do not run under `--no-extensions`, so there are no UCCH agents to install; solution §6.4. The hook goes to `agent/ucch-guard.ts`, for `--hook`.)*
    3. It writes `agent/config.yml` with `autoResume: false`.
    4. `providerEnv("omp", { openrouterKey })` follows §3.3.
  - **Acceptance:**
    - A test shows the environment holds exactly the §3.3 variables plus `terminalEnv()`, with no other credentials.
    - A test shows the guard hook blocks `git push` in a fake `tool_call` event.
  - **Verify:** `pnpm test -- providers`
- [x] **OM1.5 — Install OMP in the image** — 6bbfc80

  - **Depends:** OM0.1
  - **Files:** `Dockerfile`, `deploy.md`, `README.md`
  - **Steps:**
    1. Add `ARG OMP_VERSION` and install by the OM0.1 route into `/opt/omp`, with a checksum.
    2. Add `omp --version` as a build assertion.
    3. Bake `OMP_SKIP_SETUP=1` into the environment.
    4. Do not add LSP or DAP yet; that is OM7.
  - **Acceptance:** `docker compose build` works and `docker run … omp --version` prints the pin. The image size change is recorded in the commit message.
  - **Verify:** `docker compose build && bash scripts/smoke-container.sh`

---

## Phase OM2: RPC client and `OmpProvider`

- [x] **OM2.1 — `omp-rpc.ts`** — 8a6beca

  - **Depends:** OM0.3
  - **Files:** new `packages/providers/src/omp-rpc.ts`, `omp-rpc-types.ts` and `omp-rpc.test.ts`; reuses `process.ts` (`ProcessHost`, `splitLines`) and `testing.ts`
  - **Steps:** implement solution §2 rules 1–8. The types cover the frames in the [rpc](https://omp.sh/docs/rpc) tables, with an open index signature.
  - **Acceptance:** the tests cover:
    - the `ready` barrier and its timeout
    - out-of-order responses matched by `id`
    - `parse` errors
    - v2 chunk reassembly, including a corrupt chunk giving `rpc_frame_error`
    - unknown frames passed through
    - `close()` exit 0
    - `kill()` escalation
  - **Verify:** `pnpm test -- omp-rpc`
- [x] **OM2.2 — `ompArgv` and mappings** — 3e34776

  - **Depends:** OM2.1, OM0.4
  - **Files:** new `packages/providers/src/omp.ts`, `omp.test.ts`
  - **Steps:**
    1. Implement `ompArgv` per solution §3.1 with the OM0 answers (`--resume` or `switch_session`; the untrusted flags).
    2. Add `approvalFor` and `thinkingFor` (§3.2).
    3. Write a block comment on the load-bearing flags: `rpc-ui`, `--no-extensions`, `--config`.
  - **Acceptance:** snapshot tests for every permission mode × effort × resume × trusted combination. A test that `--yolo` never appears outside `allow_all`.
  - **Verify:** `pnpm test -- omp`
- [x] **OM2.3 — `OmpNormaliser`** — 5be8559

  - **Depends:** OM2.1, OM0.2
  - **Files:** `packages/providers/src/omp.ts`, `omp.test.ts`
  - **Steps:** implement the solution §3.4 table. Leave the subagent rows out; that is OM5.1.
  - **Acceptance:**
    - Each OM0.2 fixture produces an exact expected `DomainEvent[]`.
    - Every `agent.tool_use` has a matching `agent.tool_result`.
    - `agent.session_started` comes before the first delta.
    - Unknown frames produce nothing.
  - **Verify:** `pnpm test -- omp`
- [x] **OM2.4 — `OmpProvider.run`, `probe` and permissions** — 4d996c0

  - **Depends:** OM2.2, OM2.3, OM1.4
  - **Files:** `packages/providers/src/omp.ts`, `registry.ts` (`createProviders({ ompBin })`), `omp.test.ts`
  - **Steps:**
    1. `run()` follows the §3.6 lifecycle.
    2. `answerPermission` follows §3.5, or its fallback if OM0.3 Q2 said no.
    3. `interrupt` sends `abort` then closes; `kill` kills.
    4. `probe()` follows §1.4.
  - **Acceptance:** against the fake host:
    - the confirm fixture round trip emits `permission_requested`, then `permission_resolved`, then `tool_result`;
    - an interrupt mid-stream ends with `agent.turn_completed` or `turn_failed`, never hanging;
    - a forbidden variable refuses the run before spawn.
  - **Verify:** `pnpm test -- omp`
- [x] **OM2.5 — Overlay writer** — 80e7f35

  - **Depends:** OM0.1, OM1.4
  - **Files:** new `apps/server/src/omp-overlay.ts`, `omp-overlay.test.ts`
  - **Steps:**
    1. Write the solution §4 YAML from the workspace settings, preset and permission mode, to `<subject>/omp/run/<turnId>.yml` with mode 0600.
    2. Return a disposer that deletes it.
  - **Acceptance:** snapshot tests, plus a test that every emitted key path exists in `fixtures/omp-config-list.json`.
  - **Verify:** `pnpm test -- omp-overlay`
- [x] **OM2.6 — Server wiring for OMP turns** — f372e04

  - **Depends:** OM2.4, OM2.5
  - **Files:** `apps/server/src/agent.ts` (CLI path around line 775; `#decryptKey` usage at line 590), `providers.ts` (`provider()` returns OMP), `turn-scheduler.ts` (`TurnKind` adds `"omp"`, `ompTotal`), `index.ts:232`
  - **Steps:**
    1. An `omp` turn decrypts the OpenRouter key and writes the overlay.
    2. It builds `ProviderRunInput` with `instructions` (knowledge plus the UCCH section, §3.8) and runs through the same CLI path as Claude: session binding, `#cliPrompts`, `#cliRuns`, kill on shutdown.
    3. It is scheduled as `kind: "omp"`.
    4. The overlay is deleted in `finally`.
  - **Acceptance:**
    - A turn with `provider: "omp"` against `fake-omp` (OM2.8) streams, binds `providerSessionId`, and resumes on the second turn.
    - Permission prompts appear in the chat.
    - Stop works.
  - **Verify:** `pnpm test -- agent`, plus a manual turn with real OMP on the dev machine
- [x] **OM2.7 — `OMP_ENABLED` routing** — 5749268

  - **Depends:** OM2.6
  - **Files:** `apps/server/src/agent.ts` (`resolveProvider`), its test
  - **Steps:** when `OMP_ENABLED`, a thread that is unbound and resolves to `native` becomes `omp`. Bound threads keep their provider (solution §11 step 1).
  - **Acceptance:** table tests for bound × requested × account default × flag.
  - **Verify:** `pnpm test -- agent`
- [x] **OM2.8 — `fake-omp` for tests and load** — 64edf77

  - **Depends:** OM0.2
  - **Files:** new `scripts/load/fake-omp.mjs`, `scripts/load/README.md`
  - **Steps:**
    1. Replay an RPC fixture with the commands answered in order. `--rss-mb N` and `--rate`, as `fake-claude.mjs` does (PF0.5).
    2. Answer `get_session_stats` with fixed numbers.
  - **Acceptance:** OM2.6's test and the e2e tests run with no network.
  - **Verify:** `OMP_BIN=scripts/load/fake-omp.mjs pnpm test -- agent`

---

## Phase OM3: Host tools, knowledge, presets

- [x] **OM3.1 — Factor out `runTool`** — 76f62b9

  - **Depends:** —
  - **Files:** `packages/agent/src/loop.ts`, new `packages/agent/src/run-tool.ts`, `index.ts` exports
  - **Steps:** move `runTool` and its confinement and executor plumbing out of `loop.ts` without changing behaviour.
  - **Acceptance:** `loop.test.ts` passes unchanged.
  - **Verify:** `pnpm test -- agent`
- [x] **OM3.2 — Host-tool runner** — e3ce950

  - **Depends:** OM3.1, OM2.6, OM0.3
  - **Files:** `packages/providers/src/omp.ts` (`set_host_tools`, `host_tool_call` → `onHostToolCall` → `host_tool_result`, `host_tool_cancel`), `apps/server/src/agent.ts` (the runner using `run-tool.ts`), `packages/agent/src/registry.ts` (a `hostToolsFor(preset)` list)
  - **Steps:** advertise the solution §3.7 table. Map schemas to the format OM0.3 Q3 found. Cancel aborts the tool's `AbortSignal`. Emit tool events only if OMP does not (OM0.3).
  - **Acceptance:**
    - The host-tool fixture works end to end.
    - A document render from an OMP turn produces the same `upload.changed` / document events as a native turn.
    - Cancel stops a running research fetch.
  - **Verify:** `pnpm test -- omp agent`
- [x] **OM3.3 — Knowledge and the UCCH prompt section** — a876e12

  - **Depends:** OM2.6
  - **Files:** `apps/server/src/agent.ts`, `packages/agent/src/prompt.ts` (`renderKnowledge`)
  - **Steps:**
    1. `instructions` = `.ucch/` knowledge plus the short UCCH section (solution §3.8).
    2. Record it as `context.injected` (`system_prompt`), as the native loop does.
    3. Don't inject AGENTS.md separately for OMP.
  - **Acceptance:** the thread log shows the exact appended prompt, and AGENTS.md is not duplicated.
  - **Verify:** `pnpm test -- agent prompt`
- [x] **OM3.4 — Research and documentation presets on OMP** — 605debc

  - **Depends:** OM3.2
  - **Files:** `apps/server/src/agent.ts` (research path, line 844; documentation path, line 939), `omp-overlay.ts`, the guard hook
  - **Steps:** run the research and documentation flows as OMP turns with the host tools and `tools.approval` per solution §3.7. The `docs/`-only write rule is enforced in the guard hook.
  - **Acceptance:**
    - With `OMP_ENABLED`, a research turn and a documentation turn produce the same outputs as on native, compared on the same prompt by hand.
    - A write outside `docs/` is blocked in documentation mode.
  - **Verify:** `pnpm test`, plus a manual run of both flows

---

## Phase OM4: Context management and handoff

- [x] **OM4.1 — Compaction events and dividers** — f5da7ae

  - **Depends:** OM2.3
  - **Files:** `packages/providers/src/omp.ts`, `apps/web/src/components/project-chat.tsx`
  - **Steps:**
    1. `auto_compaction_end` becomes `context.injected` (`compaction`), per solution §5.1.
    2. The chat renders a collapsible divider with the method and the tokens before and after.
  - **Acceptance:** the compaction fixture produces the event, and the divider renders in the Playwright test.
  - **Verify:** `pnpm test -- omp && pnpm --filter @ucch/web e2e compaction`
  > Note: `e2e -- compaction` passes the `--` on to Playwright, which then runs every spec; the filter goes without it. The spec needs a server with `OMP_ENABLED=true` and `OMP_BIN=scripts/load/fake-omp-compaction.sh` (its header says how).
- [x] **OM4.2 — `context.usage` and the meter** — d0e25e4

  - **Depends:** OM2.6, OM0.3
  - **Files:** `packages/protocol/src/events.ts`, `apps/server/src/agent.ts`, `apps/web/src/components/context-meter.tsx`, `lib/context-window.ts`
  - **Steps:**
    1. After each `turn_end`, call `get_session_stats` and emit a transient `context.usage`.
    2. The meter shows used / window / threshold for OMP threads, and keeps today's estimate for the others.
  - **Acceptance:** the meter moves during an OMP turn and drops after compaction.
  - **Verify:** `pnpm typecheck && pnpm test && pnpm --filter @ucch/web build`
- [x] **OM4.3 — Compact and Hand off actions (OMP threads)** — 0f317d8

  - **Depends:** OM4.1
  - **Files:** `packages/protocol/src/commands.ts` (`thread.compact`, `thread.handoff`), the server decide and reactor, a thread menu component
  - **Steps:** implement solution §5.3: idle OMP threads only, a short process on the thread's session, RPC `compact` / `handoff` with `customInstructions`.
  - **Acceptance:**
    - Both actions shrink the context (as the meter shows) and add a divider.
    - On a running thread they are refused with a clear message.
  - **Verify:** `pnpm test`, plus a manual run
  > As built: the actions are the composer's `/compact` and `/handoff` (the chat has no thread menu); `e2e/compact.spec.ts` drives both against fake-omp and checks the dividers and the meter. Solution §5.3 updated.
- [x] **OM4.4 — Brief builder (`omp-handoff.ts`)** — af452ed

  - **Depends:** OM2.1
  - **Files:** new `apps/server/src/omp-handoff.ts` and its test
  - **Steps:**
    1. Render a thread's transcript from the event log: user and assistant text, tool calls with results cut to 2 KB each, changed files.
    2. Run `omp -p --no-session --no-tools --model @smol` with the fixed handoff instruction and `focus` (solution §5.4).
    3. Return the brief.
  - **Acceptance:** the test, against `fake-omp`, checks the transcript rendering has a token cap and that secrets matching `*_API_KEY=` are masked.
  - **Verify:** `pnpm test -- omp-handoff`
- [ ] **OM4.5 — Cross-provider handoff**

  - **Depends:** OM4.4
  - **Files:**
    - `packages/protocol` (`thread.handoff_to`, `thread.handoff_requested`, `thread.handed_off`)
    - `packages/db`: `threads.handoff_from_thread_id`, plus a migration
    - the server decide and reactor
    - `thread.create` (new `worktreeOf`)
    - `project-chat.tsx` (the links)
  - **Steps:**
    1. Implement solution §5.4 steps 1–4.
    2. The new thread shares the source worktree.
    3. The source thread shows "Continued in →".
  - **Acceptance:**
    - Claude → Codex, Codex → OMP and OMP → Claude all work against the fake CLIs.
    - The new thread's first message holds the brief.
    - Files in the worktree are untouched by the handoff.
  - **Verify:** `pnpm test && pnpm --filter @ucch/web e2e -- handoff`
- [ ] **OM4.6 — Automatic handoff on usage limit**

  - **Depends:** OM4.5
  - **Files:**
    - `packages/providers/src/claude.ts` and `codex.ts` (classify limit errors into a `limit` flag on `agent.turn_failed`, a new optional field)
    - `apps/server/src/agent.ts`
    - workspace settings (toggle plus fallback provider)
  - **Steps:** when the toggle is on and a CLI turn fails with `limit`, run `thread.handoff_to` with the fallback provider and re-send the failed user message there.
  - **Acceptance:** a recorded rate-limit fixture triggers exactly one handoff, and a second failure doesn't loop.
  - **Verify:** `pnpm test -- claude codex agent`

---

## Phase OM5: Subagents

- [ ] **OM5.1 — Subagent events**

  - **Depends:** OM2.3, OM0.3
  - **Files:** `packages/protocol/src/events.ts` (solution §6.1; add `agent.subagent_progress` to the transient list at line 861), `packages/providers/src/omp.ts`
  - **Steps:** send `set_subagent_subscription progress` at turn start, and map the lifecycle and progress frames.
  - **Acceptance:** the subagent fixture gives one `started` and one `finished`, with progress in between.
  - **Verify:** `pnpm test -- omp`
- [ ] **OM5.2 — Claude Code Task subagents made visible**

  - **Depends:** OM5.1
  - **Files:** `packages/providers/src/claude.ts` (line 353), new fixture `fixtures/claude-task.jsonl` (recorded), `claude.test.ts`
  - **Steps:** implement solution §6.2 for Claude. Subagent prose never becomes `agent.text_delta`.
  - **Acceptance:** the fixture yields subagent events, and the turn's own text is unchanged compared with today's output.
  - **Verify:** `pnpm test -- claude`
- [ ] **OM5.3 — Subagent card in the chat**

  - **Depends:** OM5.1
  - **Files:** `apps/web/src/components/project-chat.tsx` (and a new `subagent-card.tsx`), `lib/agent-activity.ts`
  - **Steps:** implement solution §6.3, following the web conventions.
  - **Acceptance:** live progress while running, and the result expands when done. It works for OMP `task`, Claude `Task` and `mcp__omp__omp_task`.
  - **Verify:** `pnpm --filter @ucch/web build && pnpm --filter @ucch/web e2e -- subagent`
- [ ] **OM5.4 — Caps and metrics**

  - **Depends:** OM5.1, OM0.6
  - **Files:** `omp-overlay.ts` (`task.*`), `turn-scheduler.ts` (count worker subprocesses if OM0.3 Q6 says they are processes), `metrics.ts`
  - **Steps:** apply `OMP_WORKERS_PER_TURN` and `maxRecursionDepth: 1`, and export `omp_subagents_total`.
  - **Acceptance:** a turn asking for 10 parallel scouts never has more than 4 running, as the progress events show.
  - **Verify:** `pnpm test`, plus a manual run
- [ ] **OM5.5 — Isolated fan-out edits (opt-in)**

  - **Depends:** OM5.4
  - **Files:** `omp-overlay.ts`, workspace settings
  - **Steps:** a workspace toggle sets `task.isolation.mode: auto` with `merge: patch` and `OMP_WORKTREE_DIR` under the subject. A failed patch apply surfaces as a failed subagent with its reason.
  - **Acceptance:** two workers editing disjoint files both land in the thread's worktree, and checkpoint/revert covers them.
  - **Verify:** manual run, plus `pnpm test`

---

## Phase OM6: `omp-bridge` for Claude Code and Codex

- [ ] **OM6.1 — Package skeleton**

  - **Depends:** OM2.1
  - **Files:** new `packages/omp-bridge/` (`package.json`, `src/index.ts`, `build.mjs`, `tsconfig.json`), `pnpm-workspace.yaml`, root `vitest.config.ts` include
  - **Steps:** an MCP stdio server on `@modelcontextprotocol/sdk` that reads the solution §10.1 environment and imports `omp-rpc.ts`. One tool, `omp_ping`, returns `omp --version`.
  - **Acceptance:** `claude -p --mcp-config` (OM0.5 setup) can call `omp_ping`.
  - **Verify:** `pnpm typecheck && pnpm test -- omp-bridge`
- [ ] **OM6.2 — `omp_task`, `omp_review`, `omp_symbols`, `omp_rename`, `omp_codemod`, `omp_debug`, `omp_recall`, `omp_retain`, `omp_handoff_brief`**

  - **Depends:** OM6.1
  - **Files:** `packages/omp-bridge/src/tools/*.ts` and tests
  - **Steps:** implement the solution §10.2 table: schemas, `--tools` allowlists, models, `--max-time`, output caps, a cost line, and `isError` on failure.
  - **Acceptance:** against `fake-omp`, each tool's argv matches its row and its result follows the format. `apply: false` never passes a write tool.
  - **Verify:** `pnpm test -- omp-bridge`
- [ ] **OM6.3 — Scheduler lease and budget**

  - **Depends:** OM6.2, OM2.6
  - **Files:** `apps/server/src/turn-scheduler.ts` (`lease()`), a new local socket endpoint, `packages/omp-bridge/src/lease.ts`
  - **Steps:** implement solution §10.5. Bridge calls take an OMP slot or return "busy" after 30 s. `UCCH_BRIDGE_MAX_CALLS` is enforced per process.
  - **Acceptance:** with `OMP_TURN_TOTAL=1`, a second concurrent bridge call waits, then reports busy.
  - **Verify:** `pnpm test -- turn-scheduler omp-bridge`
- [ ] **OM6.4 — Wire into Claude Code turns**

  - **Depends:** OM6.2, OM0.5
  - **Files:** `packages/providers/src/claude.ts` (`claudeArgv` `mcpConfigPath`, `probeClaude` cap), `apps/server/src/agent.ts` (write and delete the per-run MCP JSON), `providers.ts`
  - **Steps:** implement solution §10.3 for Claude: `--mcp-config`, `--strict-mcp-config`, the `--allowedTools` set per mode, and the bridge environment in the MCP JSON only.
  - **Acceptance:**
    - A Claude Code turn with the workspace bridge on can call `omp_symbols`.
    - The CLI's own environment still passes `forbiddenEnvPresent`.
    - With the bridge off, the argv is unchanged (snapshot).
  - **Verify:** `pnpm test -- claude agent`, plus a manual turn
- [ ] **OM6.5 — Wire into Codex turns**

  - **Depends:** OM6.2, OM0.5
  - **Files:** `packages/providers/src/codex.ts` (`codexArgv`), `apps/server/src/providers.ts` (the `config.toml` managed block, as the fallback)
  - **Steps:** implement solution §10.3 for Codex, using the syntax OM0.5 confirmed.
  - **Acceptance:** a Codex turn can call `omp_task scout`, and with the bridge off the argv is unchanged.
  - **Verify:** `pnpm test -- codex`, plus a manual turn
- [ ] **OM6.6 — The usage guide in instructions**

  - **Depends:** OM6.4
  - **Files:** new `packages/providers/assets/omp-bridge-guide.md`, `apps/server/src/agent.ts`
  - **Steps:** append the solution §10.4 guide to `instructions` for claude and codex when the bridge is on, and record it as `context.injected`.
  - **Acceptance:** the guide appears in the thread log only when the bridge is on.
  - **Verify:** `pnpm test -- agent`
- [ ] **OM6.7 — CLIs started by hand**

  - **Depends:** OM6.4, OM6.5
  - **Files:** `apps/server/src/shell/ucch.bashrc`, `ucch.fish`, `apps/server/src/terminals.ts` (export `UCCH_OMP_MCP`), `ucch-knowledge.test.ts`
  - **Steps:** the `claude()` / `codex()` wrappers add the bridge flags when `UCCH_OMP_MCP` is set (solution §10.3).
  - **Acceptance:** in a project terminal, `claude` and `codex` list the `omp` MCP server.
  - **Verify:** `pnpm test -- ucch-knowledge`, plus a manual run in the terminal
- [ ] **OM6.8 — Dev-machine recipe**

  - **Depends:** OM6.2
  - **Files:** `README.md` (a "Use the OMP bridge in your own Claude Code" section)
  - **Steps:** document the `claude mcp add omp -- node …/omp-bridge.mjs` recipe and the required `UCCH_OMP_*` variables (solution §10.3).
  - **Acceptance:** following the README on a clean machine gives working `omp_*` tools in a personal Claude Code session.
  - **Verify:** manual

---

## Phase OM7: Memory, code intelligence, structural edits, debugging, review

- [ ] **OM7.1 — mnemopi memory on OMP threads**

  - **Depends:** OM2.6, OM0.5
  - **Files:** `omp-overlay.ts`, `apps/server/src/agent.ts` (a stable project path, if OM0.5 Q5 requires one; solution §7.1), workspace settings (memory on/off, `llmMode`)
  - **Steps:** enable per the solution §4 memory block, with the workspace toggles.
  - **Acceptance:** a fact retained in thread A (one worktree) is recalled in thread B (another worktree) of the same project, and not in another project.
  - **Verify:** manual run, plus `pnpm test -- omp-overlay`
- [ ] **OM7.2 — Memory for CLI turns**

  - **Depends:** OM7.1, OM6.2
  - **Files:** `packages/omp-bridge/src/tools/recall.ts` and `retain.ts`, `apps/server/src/agent.ts` (end-of-turn retention, off by default)
  - **Steps:** implement solution §7.3. Retain only the final assistant text, never tool output.
  - **Acceptance:** a decision recorded in a Claude Code thread is recallable from a Codex thread and an OMP thread in the same project.
  - **Verify:** manual run, plus `pnpm test -- omp-bridge`
- [ ] **OM7.3 — Memory card**

  - **Depends:** OM7.1
  - **Files:** `apps/web/src/components/provider-settings.tsx`, a server endpoint
  - **Steps:** show stats and a Clear button via `omp -p "/memory stats|clear"`, or via the mnemopi files if `-p` slash commands don't work. Show the warning text from [memory](https://omp.sh/docs/memory).
  - **Acceptance:** the stats show, and Clear empties recall for the project.
  - **Verify:** `pnpm --filter @ucch/web build`, plus manual
- [ ] **OM7.4 — Language servers in the image**

  - **Depends:** OM1.5, OM0.4
  - **Files:** `Dockerfile` (`ARG OMP_LSP`), `omp-overlay.ts` (`lsp.*`), `ompArgv` (`--no-lsp` for untrusted projects, per OM0.4)
  - **Steps:** install `typescript-language-server`, `typescript` and `pyright` at pinned versions, and enable `lsp.*` per solution §8.2.
  - **Acceptance:**
    - An OMP turn renaming a TS symbol does a semantic rename across files.
    - Diagnostics appear after a write.
    - The LSP daemon's RSS is measured and recorded.
  - **Verify:** `docker compose build`, plus a manual turn
- [ ] **OM7.5 — Debug adapters in the image**

  - **Depends:** OM1.5
  - **Files:** `Dockerfile` (`ARG OMP_DAP`, `JS_DEBUG_DAP_SERVER`), `<subject>/omp/agent/dap.json` generation in `providers.ts`
  - **Steps:** install `debugpy` and js-debug (solution §8.3).
  - **Acceptance:** an OMP turn can set a breakpoint in a Node script and in a Python script and report the locals there.
  - **Verify:** manual turn in the container
- [ ] **OM7.6 — Trusted projects**

  - **Depends:** OM0.4, OM7.4
  - **Files:** `packages/db` (`projects.omp_trusted`), project settings UI, `ompArgv` input `trusted`
  - **Steps:** a project owner can mark a project trusted (solution §0.3). Only trusted projects get the repo's own OMP config, LSP and DAP sources.
  - **Acceptance:** the OM0.4 plants are ignored on untrusted projects and honoured on trusted ones.
  - **Verify:** `pnpm test`, plus a re-run of the OM0.4 plant repo through UCCH
- [ ] **OM7.7 — Review engine (`omp-review.ts`)**

  - **Depends:** OM2.1, OM0.5
  - **Files:** new `apps/server/src/omp-review.ts` and its test, `packages/protocol` (`review.run`, `review.completed`), `packages/db` (`reviews` table), new `packages/providers/assets/omp-agents/ucch-reviewer.md` (if needed)
  - **Steps:** implement solution §9.1–9.2, with the parser chosen by OM0.5 Q3.
  - **Acceptance:** reviewing a fixture diff with a planted bug yields at least one P0/P1 finding on the right file and line. Lock files are excluded.
  - **Verify:** `pnpm test -- omp-review`, plus a manual run
- [ ] **OM7.8 — Review in the Git view**

  - **Depends:** OM7.7
  - **Files:** `apps/web/src/components/git/*`
  - **Steps:** add Review changes, Review branch and per-commit Review, with the findings overlay, the verdict banner and Send to agent (solution §9.3).
  - **Acceptance:** findings render on the diff lines, and Send to agent posts them to the selected thread.
  - **Verify:** `pnpm --filter @ucch/web build && pnpm --filter @ucch/web e2e -- review`
- [ ] **OM7.9 — Verify with OMP in the task pipeline**

  - **Depends:** OM7.7, OM1.4
  - **Files:** `apps/server/src/task-pipeline.ts` (lines 153–161, 307–324), workspace settings
  - **Steps:** when the setting is on, run `ucch-verifier` (solution §6.4) and use its structured output. `parseVerdict` stays as the fallback.
  - **Acceptance:** a task with an unmet acceptance criterion is marked failed with findings, for a Claude Code coding step and a Codex one.
  - **Verify:** `pnpm test -- task-pipeline`

---

## Phase OM8: UI, deploy, capacity, retirement

- [ ] **OM8.1 — Settings UI**

  - **Depends:** OM2.6, OM6.4
  - **Files:** `provider-settings.tsx` (the OMP card), `workspace-harness-settings.tsx` (roles and toggles), `agent-permission-settings.tsx`, `provider-picker.tsx`
  - **Steps:** implement solution §12.4 settings.
  - **Acceptance:** every toggle round-trips and changes the next run's overlay or argv, as a server test asserts.
  - **Verify:** `pnpm typecheck && pnpm test && pnpm --filter @ucch/web build`
- [ ] **OM8.2 — `omp-login` terminal (optional subscriptions)**

  - **Depends:** OM1.4
  - **Files:** `apps/server/src/terminals.ts` (`TerminalProgram`), `index.ts` (login argv, near lines 399–400), `login-terminal-dialog.tsx`
  - **Steps:** an interactive `omp` with the subject's `PI_CODING_AGENT_DIR`, and the terms warning before it opens (solution §0.1, §12.3).
  - **Acceptance:** after `/login openrouter` or a subscription provider, `probeOmp` reports authenticated. The warning shows first.
  - **Verify:** manual
- [ ] **OM8.3 — Metrics and resource sampling**

  - **Depends:** OM2.6, PF0.2 (`../todo.md`)
  - **Files:** `apps/server/src/metrics.ts`, `resource-sampler.ts` (`omp` and `omp-lsp` classes)
  - **Steps:** export the solution §13 metrics.
  - **Acceptance:** `/metrics` shows OMP processes, cost and bridge calls during a mixed run.
  - **Verify:** `pnpm test -- metrics resource-sampler`
- [ ] **OM8.4 — Load test with OMP in the mix**

  - **Depends:** OM8.3, OM2.8, PF0.7 (`../todo.md`)
  - **Files:** `scripts/load/run.mjs` (an OMP turn mix and a bridge-call mix), `documentation/perf/omp-load-<date>.json`
  - **Steps:** run 50 users for 10 minutes with 20% OMP turns, plus bridge calls on 10% of the CLI turns. Tune `OMP_TURN_TOTAL` and `OMP_WORKERS_PER_TURN`.
  - **Acceptance:** no OOM kill, and the p95 of ack RTT and keystroke echo are within 10% of the PF baseline.
  - **Verify:** the load-verification commands in `../todo.md`
- [ ] **OM8.5 — Turn on `OMP_ENABLED` by default**

  - **Depends:** OM8.1, OM8.4, OM3.4, OM4.1
  - **Files:** `apps/server/src/config.ts`, `.env.example`, `deploy.md`
  - **Steps:** flip the default. Keep `NATIVE_LOOP_FALLBACK=true`. Write release notes in `deploy.md`.
  - **Acceptance:** new Custom threads run on OMP in production, and existing native threads still work.
  - **Verify:** `bash scripts/smoke-container.sh`
- [ ] **OM8.6 — Version bump procedure**

  - **Depends:** OM0.2
  - **Files:** `scripts/omp/record-rpc.mjs`, `deploy.md` ("Upgrading OMP")
  - **Steps:** a documented procedure: bump `OMP_VERSION`, re-record the fixtures, run `pnpm test`, read the OMP changelog for RPC changes, and re-run OM0.4.
  - **Acceptance:** a dry run of the procedure on the pinned version gives no fixture diff.
  - **Verify:** `node scripts/omp/record-rpc.mjs --check`
- [ ] **OM8.7 — Retire the native loop (release N+1)**

  - **Depends:** OM8.5, plus 14 days of `agent_turns_total{provider="native"} == 0` or every native thread archived
  - **Files:**
    - the solution §11 step 3 list
    - `packages/protocol` (drop `native`)
    - a `packages/db` migration mapping `native` defaults to `omp`
    - `registry.ts` labels
    - `apps/server/src/openrouter.ts`, if it is unused
  - **Steps:** delete the listed files and tests, and keep the host tools. Rename "Custom (legacy)" away.
  - **Acceptance:** `pnpm typecheck && pnpm test` pass. The bundle and server size reductions are recorded in the commit message.
  - **Verify:** `pnpm typecheck && pnpm test && pnpm --filter @ucch/web build && bash scripts/smoke-container.sh`

---

## Coverage check

| solution.md section          | Tasks                                         |
| ---------------------------- | --------------------------------------------- |
| §0 safety                   | OM0.4, OM1.3, OM1.4, OM7.6                    |
| §1 install / config / probe | OM0.1, OM1.2, OM1.5, OM2.4                    |
| §2 RPC client               | OM2.1                                         |
| §3 provider                 | OM2.2–OM2.7, OM3.1–OM3.4                    |
| §4 overlay                  | OM2.5                                         |
| §5 context / handoff        | OM4.1–OM4.6                                  |
| §6 subagents                | OM5.1–OM5.5                                  |
| §7 memory                   | OM7.1–OM7.3                                  |
| §8 AST / LSP / DAP          | OM7.4–OM7.6                                  |
| §9 review                   | OM7.7–OM7.9                                  |
| §10 bridge                  | OM6.1–OM6.8                                  |
| §11 retirement              | OM2.7, OM8.5, OM8.7                           |
| §12 server / web / db       | OM1.1, OM2.6, OM8.1, OM8.2                    |
| §13 capacity                | OM0.6, OM5.4, OM8.3, OM8.4                    |
| §14 testing                 | OM0.2, OM2.8, OM8.6 (and every task's Verify) |
