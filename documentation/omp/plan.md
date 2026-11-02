# OMP in UCCH: plan

**Status:** proposal · **Date:** 2026-10-31 · **Target:** the existing single-container Dokploy deployment (4 vCPU / 8 GB), Claude Code and Codex as the main providers

The detailed design is in [`solution.md`](./solution.md). The ordered tasks are in [`todo.md`](./todo.md). The performance plan in [`../plan.md`](../plan.md) is separate and stays live. Where the two touch (memory per process, turn caps), this plan defers to that one's measurements.

Every claim about OMP below links the page of the official docs it comes from ([https://omp.sh/docs](https://omp.sh/docs)), as read on 2026-10-31. Anything those pages do not settle is marked **(verify in OM0)** and is answered by the spike before code depends on it.

---

## TL;DR

1. **"Custom" becomes OMP.** The harness's own loop (`packages/agent`, about 4,000 lines of loop, context and tools over OpenRouter) is replaced by OMP run as a subprocess in RPC mode, still on the account's OpenRouter key. OMP brings compaction with automatic handoff, subagents, memory, AST edits, LSP, DAP and code review. Writing those ourselves would take months. The old loop stays one release behind `NATIVE_LOOP_FALLBACK`, then goes.
2. **Claude Code and Codex stay in charge of their own turns.** They keep running on the person's subscription, exactly as today. UCCH adds **`omp-bridge`**, an MCP server that gives them OMP's specialist capabilities as tools: subagents (scout, reviewer, security-reviewer, librarian), semantic rename and references, structural codemods, a real debugger, code review, and a memory bank shared with OMP threads.
3. **UCCH itself uses OMP for what crosses providers:**
   - **Handoff.** Move a thread from Claude Code to Codex or OMP when the quota or the context runs out. This feeds the "auto queueing when limits finish" and "multi subscription" items in [`../idea.md`](../idea.md).
   - **Memory.** One mnemopi bank per project.
   - **Review.** A "Review" button in the Git view, which is the "code review and branching" item in `idea.md`.
4. **Nothing changes who pays.** CLI turns stay on subscriptions, and `FORBIDDEN_ENV` stays. OMP and bridge calls use the OpenRouter key the account already holds for "Custom". Logging OMP into a Claude or ChatGPT subscription is possible ([providers](https://omp.sh/docs/providers)), but it is opt-in only and carries a terms warning (see [Risks](#8-risks)).
5. **Order.** OM0 spike and fixtures (2–3 days) → OM1–OM3, OMP as the "Custom" provider (1–1.5 weeks) → OM4–OM5, context, handoff and subagents (1 week) → OM6, the bridge for Claude Code and Codex (1 week) → OM7, memory, code intelligence, debugging and review in the product (1 week) → OM8, UI, deploy, capacity and retiring the loop (3–5 days). The estimates are for one developer working with an agent.

---

## 1. Why

The harness has three engines, and the one we own is the weakest:

|                    | Claude Code                                                                                                                            | Codex                                                             | Custom (native)                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Who runs the loop  | the vendor CLI                                                                                                                         | the vendor CLI                                                    | `packages/agent/src/loop.ts` `runTurn`                                                                           |
| Billing            | subscription                                                                                                                           | subscription                                                      | OpenRouter key                                                                                                       |
| Context management | the CLI's own auto-compact                                                                                                             | the CLI's own                                                     | `packages/agent/src/context.ts`: prune tool results at 70% (`PRUNE_RATIO`), summarise at 85% (`COMPACT_RATIO`) |
| Handoff            | none (a thread is bound to its provider for good, `resolveProvider`, `apps/server/src/agent.ts:145`)                               | none                                                              | none                                                                                                                 |
| Subagents          | the CLI's Task tool, **hidden from the UI** (`parent_tool_use_id` lines are dropped, `packages/providers/src/claude.ts:353`) | none surfaced                                                     | none                                                                                                                 |
| Memory             | `.ucch/` knowledge through `--append-system-prompt`                                                                                | `.ucch/` knowledge ahead of the first message (`codexPrompt`) | `.ucch/` through `buildPrompt`                                                                                   |
| Code intelligence  | text search                                                                                                                            | text search                                                       | `glob` / `grep` tools                                                                                            |
| Structural edits   | string replace                                                                                                                         | patch                                                             | `edit_file` string replace                                                                                         |
| Debugging          | shell only                                                                                                                             | shell only                                                        | shell only                                                                                                           |
| Code review        | none in the product                                                                                                                    | none                                                              | the verify step of `apps/server/src/task-pipeline.ts` (`verifyPrompt` / `parseVerdict`)                        |

Every row is something [OMP](https://omp.sh/docs) already does and tests. The fastest way to make the harness more efficient is to stop maintaining a fourth-best agent loop and to lend the first-best parts of OMP to the two CLIs people actually use.

## 2. What OMP is

- **oh-my-pi (`omp`)** is a terminal coding agent, a fork and rewrite of Mario Zechner's Pi ([`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)). It is MIT licensed, with a TypeScript surface over a Rust core (`pi-natives`, `pi-ast`, `pi-edit`, `pi-shell`, …).
- **Five launch modes** ([run modes](https://omp.sh/docs/modes)): the interactive TUI; one-shot `omp -p` / `--mode text`; `--mode json` (JSONL events); `--mode rpc` / `rpc-ui` (a newline-delimited JSON protocol over stdio); and `omp acp` (Agent Client Protocol, for editors).
- **An SDK, `@oh-my-pi/pi-coding-agent`**, that runs **in Bun ≥ 1.3.14 only** ([SDK](https://omp.sh/docs/sdk)). The UCCH server is Node 22, so UCCH uses **RPC**. The SDK page itself recommends RPC "if your host is in another language or needs process isolation".
- **Providers** ([providers](https://omp.sh/docs/providers)): `openrouter` (`OPENROUTER_API_KEY`), `anthropic` (Claude Pro/Max OAuth or a key), `openai-codex` (ChatGPT subscription OAuth) and many more. Models are picked by *role* ([agents &amp; roles](https://omp.sh/docs/agents-and-roles)): `default`, `smol`, `slow`, `plan`, `task`, `advisor`, `tiny`, `commit`, `vision`, `designer`.
- **Reads our existing files** ([context files](https://omp.sh/docs/context-files), [skills](https://omp.sh/docs/skills)): `AGENTS.md`, `.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `.claude/skills/`, `.codex/skills/`. A project set up for Claude Code mostly works in OMP as it is.

## 3. Goals and non-goals

**Goals**

- G1. Claude Code and Codex remain first-class, subscription-billed and unchanged in how they drive a turn.
- G2. "Custom" runs on OMP and gains everything in §6. It keeps UCCH's own tools (documents, uploads, research, Crawl4AI web) through RPC host tools.
- G3. Claude Code and Codex turns can call OMP's capabilities: subagents, code intelligence, structural edits, debugging, review, memory.
- G4. One event vocabulary. OMP output is normalised into the existing `DomainEvent`s, as `claude.ts` and `codex.ts` already do (the design rule in `packages/providers/src/types.ts`). The UI and revert logic never branch on provider.
- G5. No billing surprises. Every OMP process has an explicit allowlist of credential variables.
- G6. Bounded resources. OMP processes and subagents count against `TurnScheduler` caps sized from measurement (`../plan.md` row 5).

**Non-goals**

- Replacing the Claude Code or Codex CLIs with OMP driving Claude or GPT models. The user chose the tool-layer design. The "OMP-driven" variant is out of scope, and §8 covers the risk if it is ever revisited.
- Exposing OMP's TUI to users. UCCH's chat stays the interface.
- ACP. It is built for editors; UCCH is the host and speaks RPC.
- A security sandbox. OMP's isolation "is not a security sandbox" ([subagents](https://omp.sh/docs/subagents)); confinement stays the container's and the run environment's job.

## 4. Target architecture

```
                         ┌──────────────────────── apps/server ─────────────────────────┐
 browser ── WS ────────▶ │ AgentTurnReactor ── resolveProvider ──┬─────────┬──────────┬──┘
                         │                                       │         │          │
                         │                 ┌─────────────────────┘         │          │
                         │                 ▼                               ▼          ▼
                         │  claude -p --mcp-config ucch-mcp.json   codex exec -c mcp_servers.omp…   omp --mode rpc-ui
                         │      (subscription)       │                 (subscription)  │            (OpenRouter key)
                         │                           │ stdio MCP                       │ stdio MCP     │  ▲ host_tool_call /
                         │                           ▼                                 ▼               │  │ host_tool_result
                         │                  ┌────────────────── omp-bridge (packages/omp-bridge) ──┐  │  │
                         │                  │ omp_task · omp_review · omp_symbols · omp_rename     │  │  └─ UCCH tools
                         │                  │ omp_codemod · omp_debug · omp_recall · omp_retain    │  │     (documents, uploads,
                         │                  │ omp_handoff_brief                                    │  │      research, web)
                         │                  └──────── spawns: omp --mode rpc --no-session ─────────┘  │
                         │                                         │                                  │
                         │                                         ▼                                  ▼
                         │     CREDS_ROOT/<subject>/omp/  (PI_CODING_AGENT_DIR)                       │
                         │       ├─ sessions/            OMP JSONL sessions (resumeToken = session id)│
                         │       ├─ memories/mnemopi/    one SQLite bank per project ◀────────────────┘
                         │       └─ config.yml           generated UCCH overlay (solution §4)
                         │  native loop (packages/agent) — fallback only, removed in OM8
                         └───────────────────────────────────────────────────────────────────────────────
```

- **One shared RPC client**, `packages/providers/src/omp-rpc.ts`, is used by the provider, the bridge, the handoff builder and the reviewer.
- **The bridge is per CLI process.** Claude Code and Codex start it as a stdio MCP server at the beginning of a turn, and it dies with the turn.
- **Credentials and state are per subject**, like `claude/` and `codex/` today (`ProviderService.credsDir`, `apps/server/src/providers.ts:90`). A workspace's runs share its subject, so memory is shared within a workspace and never across accounts.

## 5. Phases

| Phase                                        | Outcome                                                                                                                                                                                                                                                          | Depends  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **OM0** spike and fixtures             | OMP installed and pinned. Recorded RPC JSONL fixtures for a plain turn, a tool call, an approval, compaction, handoff, a subagent and a host tool. Measured RSS per process and per worker. Every **(verify in OM0)** question answered in a short report. | —       |
| **OM1** protocol and config            | `omp` in `ProviderId` / `CliProviderId`. Config keys. Per-provider credential rules. The `omp/` credential directory.                                                                                                                                    | OM0      |
| **OM2** RPC client and `OmpProvider` | "Custom" turns run on OMP, with streaming, tools, permissions, interrupt and resume.                                                                                                                                                                             | OM1      |
| **OM3** host tools and knowledge       | UCCH tools (documents, uploads, research, web) usable from OMP. `.ucch/` knowledge appended. The research and documentation presets ported.                                                                                                                    | OM2      |
| **OM4** context and handoff            | Compaction and handoff visible in the thread. Manual Compact / Handoff buttons. Cross-provider handoff to a linked continuation thread.                                                                                                                          | OM2      |
| **OM5** subagents                      | Subagent cards in the chat, for OMP and for Claude Code's Task tool. Project agent definitions. Caps.                                                                                                                                                            | OM2      |
| **OM6** `omp-bridge`                 | Claude Code and Codex turns (and CLIs started by hand) can call `omp_*` tools. Opt-in per workspace.                                                                                                                                                           | OM2      |
| **OM7** memory, LSP, AST, DAP, review  | mnemopi memory shared across providers. Language servers and debug adapters in the image. A Review button in the Git view. The task pipeline's verify step on OMP's reviewer.                                                                                    | OM3, OM6 |
| **OM8** UI, deploy, capacity, retire   | Settings cards. Dockerfile pin. Load-tested caps. Native loop deleted once a release has passed with no fallback use.                                                                                                                                            | all      |

## 6. Feature by feature

Each block says what OMP does (with its docs), what UCCH does with it on **OMP threads** ("Custom"), and how it reaches **Claude Code and Codex threads**.

### 6.1 Context management ([compaction](https://omp.sh/docs/compaction))

**What OMP does**

- Automatic maintenance runs when context passes the model's threshold, mid-turn during long turns (`compaction.midTurnEnabled`), and after an overflow. With `compaction.asyncEnabled` it can prepare a summary early.
- Before summarising, it "removes stale file reads, empty searches, and similar bulk that is safe to drop" (`compaction.supersedeReads`, `compaction.dropUseless`).
- Methods are tried in `compaction.methodOrder`, default `[remote, snapcompact, handoff, shake, soft]`. `compaction.keepRecentTokens` (20000) stays verbatim.
- Manual commands: `/context`, `/compact [soft|remote|snapcompact] [focus]`, `/shake [elide|images|thinking]`.

**OMP threads**

- UCCH turns this on with its own `methodOrder` (handoff first, solution §4).
- The RPC events `auto_compaction_start` and `auto_compaction_end` become a `context.injected` with `source: "compaction"`, which `session-log.ts` already treats as a checkpoint, plus a divider in the chat.
- The context meter (`apps/web/src/components/context-meter.tsx`) reads `get_session_stats`.
- New Compact and Handoff actions map to the RPC `compact` and `handoff` commands.

**Claude Code and Codex threads**

- Their CLIs keep their own compaction. UCCH cannot replace it without driving the loop.
- What they gain:
  - **Delegation shrinks their context.** A scout or librarian subagent (6.3) reads 40 files and returns a page, instead of the CLI reading the 40 files itself. This is OMP's main efficiency lever for a CLI turn.
  - **Cross-provider handoff** (6.2), for when a CLI session is full or out of quota.

### 6.2 Automatic handoff ([handoff](https://omp.sh/docs/handoff))

**What OMP does**

- `/handoff [focus]` "compacts a long session into a focused continuation brief without creating a new session": the work done, decisions, next steps.
- It becomes automatic when `handoff` is early in `compaction.methodOrder`.
- `compaction.handoffSaveToDisk` writes `handoff-*.md` for automatic handoffs.
- Failures are non-destructive.

**OMP threads**

- Automatic handoff is the first compaction method.
- Briefs are saved to disk and also recorded as `context.injected` so they are visible and reproducible.

**Any thread, any provider: UCCH cross-provider handoff (new)**

- Today a thread is bound to its provider for good. The new **Hand off to…** action:
  1. Builds a brief from the UCCH transcript with a one-shot OMP call (`omp_handoff_brief`, solution §5.4).
  2. Opens a new thread on the target provider (Claude Code, Codex or OMP) in the **same worktree**, seeded with the brief.
  3. Links the two threads (`handoffFrom` / `handoffTo`).
- **Automatic triggers** (opt-in per workspace):
  - a CLI turn fails with a usage-limit error;
  - context passes 90% on a CLI thread whose CLI reports usage (`mapUsage` in `claude.ts`).
- This is the foundation for the `idea.md` items "auto queueing … after the limit resets" and "multi claude code subscription connection".

### 6.3 Subagents ([subagents](https://omp.sh/docs/subagents), [authoring](https://omp.sh/docs/subagent-authoring), [roles](https://omp.sh/docs/agents-and-roles))

**What OMP does**

- Built-in agents: `scout` (read-only exploration), `reviewer`, `security-reviewer`, `librarian` (external library research), `designer`, `task`, `sonic` (mechanical edits).
- Each one is a child session that receives an assignment rather than the parent's history, which is where the context saving comes from.
- Settings: `task.maxConcurrency` (32), `task.maxRecursionDepth` (2), `task.softRequestBudget` (200), `task.maxRuntimeMs`.
- Isolation through `task.isolation.mode` (`none` / `auto`), with patches merged back by default (`task.isolation.merge: patch`).
- Custom agents are Markdown files with frontmatter (`name`, `description`, `tools`, `model`, `thinking-level`, `spawns`, `output` JSON Schema, `blocking`, …) in `.omp/agents/`.

**OMP threads**

- Subagents are on, capped at **4 concurrent per turn** and **depth 1**, which suits an 8 GB box shared by 50 users. They are raised only after OM8 measurement.
- `set_subagent_subscription progress` streams `subagent_lifecycle` and `subagent_progress`, which become new `agent.subagent_*` events and a collapsible card per worker in the chat.
- Workers use the cheap `smol` role (scout, librarian and sonic already route there).
- UCCH ships project agents generated from `.ucch/`:
  - `ucch-verifier`, structured `output`, which replaces `parseVerdict`'s regex;
  - `ucch-researcher`.

**Claude Code and Codex threads**

- The bridge tool `omp_task(agent, assignment)` runs one OMP agent and returns its result. The CLI decides when to delegate.
- Claude Code's own Task subagents are **shown**, not dropped, by mapping `parent_tool_use_id` lines onto the same `agent.subagent_*` events.

### 6.4 Memory ([memory](https://omp.sh/docs/memory))

**What OMP does**

- Memory is off by default. The backends are `local` (distilled files), `mnemopi` (local SQLite with remember, recall and forget plus automatic retention) and `hindsight` (remote server).
- mnemopi settings: `mnemopi.scoping: per-project` (the default), `autoRecall`, `autoRetain`, `retainEveryNTurns` (4), `recallLimit` (8), and `llmMode` (`smol` / `remote` / `none`).
- Tools: `recall`, `retain`, `reflect`, `memory_edit`.

**OMP threads**

- `memory.backend: mnemopi`, per project, stored under the subject's credential directory.
- `.ucch/` stays the **human-curated** knowledge, and mnemopi is the **learned** knowledge. Recalled memory is background context, and "the current information wins" (memory page).

**Claude Code and Codex threads**

- The bridge exposes `omp_recall` and `omp_retain` against the **same bank**.
- At the end of a CLI turn, UCCH may retain a short summary, opt-in. Lessons learnt under one provider are then recallable from every provider.

### 6.5 Structural edits ([editing](https://omp.sh/docs/editing), [tools](https://omp.sh/docs/tools))

**What OMP does**

- `edit` makes "checked, line-anchored patches", anchored by content hash ("hashline" in the README).
- `ast_edit` "previews syntax-aware codemods, then accepts or rejects them". It is on by default (`astEdit.enabled`) and capped at `PI_MAX_AST_FILES` (1,000).
- `ast_grep` searches by syntax shape, off by default.
- Merge conflicts are addressed as `conflict://N`.

**OMP threads**

- All of the above is on, with `ast_grep` enabled.

**Claude Code and Codex threads**

- `omp_codemod(pattern, rewrite, scope, mode: "preview"|"apply")`. A preview returns the proposed diff; apply writes it, and UCCH's checkpointing and file events see the change as usual.
- Useful for large mechanical refactors that a CLI would otherwise do file by file, burning context.

### 6.6 Code intelligence ([code intelligence](https://omp.sh/docs/code-intelligence))

**What OMP does**

- LSP is on by default and lazy (`lsp.lazy`), with one server per project shared through a daemon (`lsp.shared`).
- Operations: definitions, implementations, types, project-wide references, semantic rename with preview, file moves that update imports, diagnostics, quick fixes.
- `lsp.diagnosticsOnWrite` (true) returns diagnostics after every write.
- Config lives in `.omp/lsp.json`. Servers are detected from root markers **in the launch directory**, so UCCH must launch OMP at the package root.

**OMP threads**

- On. The Docker image ships `typescript-language-server` and `pyright`; others are added on demand.

**Claude Code and Codex threads**

- `omp_symbols(query, kind: definition|references|diagnostics)` and `omp_rename(symbol, newName, mode)`.
- This gives both CLIs a semantic rename they don't have.

### 6.7 Debugging ([debugging](https://omp.sh/docs/debugging))

**What OMP does**

- A real debugger over DAP: launch, attach (PID or host:port), breakpoints with conditions, step, stack, scopes, locals, evaluate.
- Adapters include `debugpy`, `js-debug-adapter`, `dlv`, `gdb`, `lldb-dap` and `codelldb`.
- Config in `.omp/dap.json`. On by default (`debug.enabled`).

**OMP threads**

- On. The image ships `debugpy` and js-debug (via `JS_DEBUG_DAP_SERVER`).

**Claude Code and Codex threads**

- `omp_debug(goal, program, args?, breakpoints?)` delegates "reproduce and find the cause" to an OMP worker with the `debug`, `read` and `bash` tools, and returns the findings.
- The CLI keeps the fix.

### 6.8 Code review ([review](https://omp.sh/docs/review))

**What OMP does**

- `/review` covers the base branch (PR style), uncommitted changes, one commit, custom instructions, or a GitHub PR URL. Run it headless with `omp -p "/review …"`.
- Findings carry priority **P0–P3**, a **confidence** of 0–1, an explanation, and a file and line range. There is a verdict of **correct** or **incorrect**.
- It is read-only. Breadth scales from one pass up to 16 parallel slices by diff size. Lock files and generated, `dist/` and vendored code are excluded.

**In the product (every provider)**

- The Git view gets **Review changes** and **Review branch** buttons, which render findings inline on the diff.
- This is the `idea.md` item "the top manager inside a project can see code changes before pushing".
- The task pipeline's verify step can call the reviewer instead of `verifyPrompt`.

**Claude Code and Codex threads**

- `omp_review(scope, focus)`. A CLI can ask for an independent review of its own work before it finishes.

### 6.9 And more

| Feature                                                                                                                                          | Docs                                                                                   | Use in UCCH                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Advisor**: a second model that reviews turns (`advisor.enabled`, `modelRoles.advisor`; severities `nit`, `concern`, `blocker`) | [advisor](https://omp.sh/docs/advisor)                                                  | Optional per workspace on OMP threads. Off by default because it doubles cost.                                                        |
| **Prewalk**: switch to a cheaper model after planning and the first edit (`prewalk.enabled`, target `@smol`)                           | [prewalk](https://omp.sh/docs/prewalk)                                                  | An "economy" toggle for OMP threads. The expensive model plans, the cheap one implements.                                             |
| **Plan mode** (`/plan`, `--plan-yolo`)                                                                                                 | [plan](https://omp.sh/docs/plan), [modes](https://omp.sh/docs/modes)                     | A Plan → Execute action for OMP threads. The task pipeline's research step.                                                          |
| **Hooks** (`.omp/hooks/pre/*.ts`, `pi.on("tool_call")`, can block)                                                                     | [hooks](https://omp.sh/docs/hooks)                                                      | A UCCH guard hook: no `git push --force`, no writes outside the worktree, no `printenv`. Fails closed.                            |
| **Approvals** (`tools.approvalMode`, `tools.approval.<tool>: allow\|prompt\|deny`)                                                       | [approvals](https://omp.sh/docs/approvals)                                              | Mapped from `AgentPermissionMode`. `deny` for `computer`, and for `browser` unless enabled.                                   |
| **Session import** (`--from-claude`, `--from-codex`)                                                                                   | [sessions](https://omp.sh/docs/sessions)                                                | Interactive picker only. Not used by automation, because handoff briefs are built from the UCCH transcript **(verify in OM0)**. |
| **Skills and context files**                                                                                                               | [skills](https://omp.sh/docs/skills), [context files](https://omp.sh/docs/context-files) | One set of `.claude/skills` works for Claude Code and OMP.                                                                          |

## 7. Efficiency: where the savings come from

1. **Context.** Delegated reading (scouts and librarians return summaries). OMP drops superseded reads and useless output before summarising. Handoff briefs replace history instead of truncating it. Workers on `smol` do bulk work cheaply.
2. **Tokens and money on OMP threads.** Prewalk and roles put cheap models on mechanical work. Remote compaction is used where the route supports it.
3. **Wall-clock time.** Parallel subagents. Async compaction prepared before the threshold. Review sliced over up to 16 workers.
4. **Correctness, which means fewer turns.** Diagnostics after writes. Semantic rename instead of find-and-replace. A debugger instead of print loops. Review findings before commit.
5. **Code we stop owning.** `packages/agent/src/loop.ts`, `context.ts`, `completion.ts`, `session-log.ts` and most of `tools/` retire in OM8. Only the UCCH-specific tools remain, as host tools.

The **costs** are real:

- Each OMP process is another runtime in the container. Its RSS is measured in OM0 and capped in OM8, and it competes with the 372 MB Claude Code process `../plan.md` measured.
- Every bridge call is a model-driven OMP session, which costs tokens and seconds.

So the bridge is **opt-in per workspace**, and its tools are described to the CLIs as "for large or specialist work", not as a default path.

## 8. Risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A cloned repository configures OMP.** OMP discovers project `.omp/config.yml`, `.omp/hooks/pre\|post/*.ts` (code that runs as the user), `.omp/lsp.json` / `.omp/dap.json` (commands it spawns), `.omp/mcp.json` / `.mcp.json`, `.omp/agents/`, plugins and skills ([settings](https://omp.sh/docs/settings), [hooks](https://omp.sh/docs/hooks), [mcp](https://omp.sh/docs/mcp)). UCCH clones anything, which is why `claudeArgv` passes `--setting-sources user` and `codexArgv` passes `--ignore-rules`. | Same rule for OMP (solution §0.3). OMP still launches at the worktree root, because LSP discovery needs the root markers there. The protection comes in four layers:1. `PI_CONFIG_DIR` renames the config directory away from `.omp`, so a stranger's `.omp/` is not OMP's **(verify in OM0 that it applies to project scope too)**.2. `--no-extensions` and `--no-rules`.3. The UCCH `--config` overlay, which outranks project config, sets every policy key.4. Project skill, MCP and LSP sources are turned off where a switch exists.Any source OM0 finds that cannot be switched off (for example root `lsp.json` or `.mcp.json`) is reported, and the project is run with `--no-lsp` until a person marks it trusted. |
| **RAM.** One OMP process per OMP turn and per bridge call, plus language servers and debug adapters, on an 8 GB box shared by 50 users.                                                                                                                                                                                                                                                                                                                                                                                         | OM0 measures. `TurnScheduler` gets a `kind: "omp"` with its own caps. Workers are limited per turn (`task.maxConcurrency: 4`) and per server. LSP is lazy and shared (`lsp.shared`). The bridge is opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Bridge cost and latency.** Every call is a model session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `--model @smol`, `--max-time`, `task.softRequestBudget`, per-call output caps (`PI_TASK_MAX_OUTPUT_BYTES`). The bridge is off by default. Each call's usage is recorded and shown on the turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Approvals over RPC.** In headless mode a `prompt` approval "fails the call" ([approvals](https://omp.sh/docs/approvals)). Interactive confirmation needs `--mode rpc-ui` and `extension_ui_request` **(verify in OM0)**.                                                                                                                                                                                                                                                                                           | If `rpc-ui` confirm works, map it to `agent.permission_requested`. If not, strict mode uses `approvalMode: write` plus `deny` lists, and the UI says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **RPC churn.** "Optional fields and new event types can be added without a version change" ([rpc](https://omp.sh/docs/rpc)).                                                                                                                                                                                                                                                                                                                                                                                                     | Pin `OMP_VERSION`. The normaliser ignores unknown frames and keeps unknown fields. Fixture tests are re-recorded on every bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Frame size.** v1 frames are capped at 1 MiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Negotiate protocol v2 and reassemble `rpc_chunk` frames (up to 64 MiB).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Subscription terms.** OMP can log into Claude Pro/Max and ChatGPT ([providers](https://omp.sh/docs/providers)), but whether a vendor permits its subscription in a third-party harness is that vendor's policy, not OMP's.                                                                                                                                                                                                                                                                                                     | Not used by default. An optional `omp-login` terminal with a warning, mirroring `CODEX_SUBSCRIPTION_WARNING`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Memory privacy.** mnemopi in `smol` mode sends extraction work to the model provider. "Do not ask omp to remember secrets" ([memory](https://omp.sh/docs/memory)).                                                                                                                                                                                                                                                                                                                                                           | Per-project scope. A `llmMode` setting per workspace (`none` for sensitive clients). Never retain tool output automatically from CLI turns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Isolation is not a sandbox** ([subagents](https://omp.sh/docs/subagents)).                                                                                                                                                                                                                                                                                                                                                                                                                                                     | It is the same trust boundary as today's CLI runs: the container, the scrubbed environment and the guard hook. Worktrees go under the subject's directory (`OMP_WORKTREE_DIR`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Docs and README disagree on the SDK runtime.** The README says "Node SDK"; the SDK page says Bun only.                                                                                                                                                                                                                                                                                                                                                                                                                        | Irrelevant to this design, which uses RPC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Behaviour changes for "Custom" users.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fallback flag for one release. Existing native-bound threads stay native until archived. New threads use OMP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 9. Open questions for OM0

1. Can `--mode rpc` / `rpc-ui` resume a session with `-r <id>` given `--session-dir`? Which session id does `get_state` / `session_info_update` report?
2. The exact `set_host_tools` tool schema, and whether host tools are offered to subagents.
3. Does `rpc-ui` emit `extension_ui_request` `confirm` for tool approvals, and what does the `confirm` payload contain?
4. The model id syntax for OpenRouter (`openrouter/<vendor>/<model>`?), from `get_available_models`.
5. RSS of an idle and a busy `omp --mode rpc` process; with one worker; with `typescript-language-server` up.
6. Codex's MCP override syntax for `codex exec` (`-c mcp_servers.<name>.command=…`) at the CLI version in the image.
7. Is `/review` output in `--mode json` structured (findings as objects) or text only? This decides whether the parser is a schema or a custom `ucch-reviewer` agent with `output:` JSON Schema.
8. Install route inside the image: the `omp.sh/install` script or a release tarball. Is it self-contained (Rust core plus a bundled runtime) or does it need Bun?

## Sources

All pages fetched 2026-10-31:

- **Overview:** [Overview](https://omp.sh/docs), [Quickstart](https://omp.sh/docs/quickstart)
- **Running OMP:** [Run modes](https://omp.sh/docs/modes), [RPC](https://omp.sh/docs/rpc), [SDK](https://omp.sh/docs/sdk), [ACP](https://omp.sh/docs/acp), [CLI](https://omp.sh/docs/cli), [Settings](https://omp.sh/docs/settings), [Environment](https://omp.sh/docs/env), [Approvals](https://omp.sh/docs/approvals)
- **Context and sessions:** [Compaction](https://omp.sh/docs/compaction), [Handoff](https://omp.sh/docs/handoff), [Sessions](https://omp.sh/docs/sessions), [Memory](https://omp.sh/docs/memory)
- **Agents and models:** [Subagents](https://omp.sh/docs/subagents), [Authoring subagents](https://omp.sh/docs/subagent-authoring), [Agents &amp; roles](https://omp.sh/docs/agents-and-roles), [Providers](https://omp.sh/docs/providers), [Advisor](https://omp.sh/docs/advisor), [Prewalk](https://omp.sh/docs/prewalk)
- **Capabilities:** [Structural edits](https://omp.sh/docs/editing), [Code intelligence](https://omp.sh/docs/code-intelligence), [Debugging](https://omp.sh/docs/debugging), [Code review](https://omp.sh/docs/review), [Tools index](https://omp.sh/docs/tools)
- **Extending:** [Hooks](https://omp.sh/docs/hooks), [MCP](https://omp.sh/docs/mcp), [Plugins](https://omp.sh/docs/plugins), [Skills](https://omp.sh/docs/skills), [Context files](https://omp.sh/docs/context-files)
- **Source code:** [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) (README, license)
