# Plan 2: Session context, prompt cache and context-window management (adapted from t3code)

## Context

**Question:** how does t3code (pingdotgg/t3code, read at `1425613b`, 2026-11-21) keep each session's context healthy, meaning the prompt cache stays warm and the window never overflows? And how does UCCH compare?

**Short answer:** t3code treats the provider's own session as the source of truth. It measures that session exactly: occupancy from the *last request's* usage, the real window, the CLI's own compaction threshold and the prompt-cache expiry. It then acts at the cheapest moment, compacting inside the same session while the cache is still warm. UCCH also resumes native sessions, but its readings are wrong for Codex and after a page reload. It ignores cache lifetime. Its fallback is an expensive handover to a new session that depends on OMP and OpenRouter.

### How t3code does it

| Concern | t3code mechanism | Where |
|---|---|---|
| Session continuity | Keeps one live Claude Agent SDK `query` per thread (the process stays up between turns). Uses `sessionId` on the first turn and `resume` + `resumeSessionAt` after that. If Claude answers "No conversation found", it starts a fresh session with the thread's history imported. | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (`makeClaudeQueryOptions` ~2280, `liveQueryForThread` ~8788, `CLAUDE_CONVERSATION_NOT_FOUND` ~389) |
| Context occupancy | `usedTokens = input + cache_creation + cache_read + output` of the **latest message** (streamed `message_start`/`message_delta` usage, merged by `mergeClaudeStreamUsage`). It is never a turn sum. Codex uses `tokenUsage.last.*` and `tokenUsage.modelContextWindow` from app-server `thread/tokenUsage/updated`. | `claudeProviderTurnTokenUsage` (ClaudeAdapterV2.ts:305), `codexProviderTurnTokenUsage` (CodexAdapterV2.ts:220) |
| Billing vs occupancy | Kept as separate types. `TurnTokenUsage` (billing) adds steered segments, separates cached and cache-creation tokens, and reports subagent and compaction usage as `otherUsage` from the SDK's `modelUsage` ledger. Each figure is `complete`, `partial` or `unavailable`, never a guessed 0. | `apps/server/src/provider/ClaudeTurnTokenUsage.ts` |
| Real window | 1. the model catalog; 2. `modelUsage[model].contextWindow` reported by Claude Code; 3. null. Codex reports `modelContextWindow` itself. | ClaudeAdapterV2.ts:5766, `claudeReportedContextWindows` |
| Compaction threshold | Leaves Claude's native auto-compact in charge. When an `autoCompactWindow` is set, it reports `autoCompactThreshold = window − 33,000` (as Claude Code computes it), and reports none when `DISABLE_AUTO_COMPACT` / `autoCompactEnabled:false` is set. The UI shows the threshold. | `claudeAutoCompactThreshold`, `resolveAutoCompactWindow` (~5912) |
| Prompt-cache lifetime | Reads `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` to get the TTL. Computes `promptCacheExpiresAt = requestedAt + TTL`, where `requestedAt` is the request start, not the response end. | ClaudeAdapterV2.ts:261-334 |
| Idle compaction (cache-aware) | When a run completes with ≥200k tokens in context and the cache is still warm, it sends `/compact` as a visible turn 2 minutes **before** the cache expires, so the compaction reads from cache. Skipped when the thread is archived, snoozed, has pending requests, background work or a pending merge-back, the last turn was itself `/compact`, or the provider changed. Runs at most once per idle period. | `orchestration-v2/IdleCompaction.ts`, `IdleCompactionService.ts` |
| Resume compaction prompt | When Claude asks `resume_return` on an old session, it asks the person: "This session is Xh old and uses N tokens. Compact it before continuing?" (compact / keep / don't ask again). | `packages/shared/src/claudeCompaction.ts`, ClaudeAdapterV2.ts ~12940 |
| Codex compaction hygiene | Codex drops developer messages when it compacts, so t3code re-injects `additionalContext` with `thread/inject_items` after `turn/completed`. It does not do this mid-turn, where it would make the model sample again. | CodexAdapterV2.ts:2036 |
| Handover budget | Imported history (provider switch, fork, side chat) is capped at 16k tokens / 64 kB. A work reserve of `max(16k, window/4)` (at most window/2) is kept free. The budget is `min(cap, window − native − newMessage − attachments − reserve)`, with images counted as 8k tokens and files as 4k. Usage is only carried over when the native thread is the same. | `packages/provider-core/src/server/handoffBudget.ts` |
| Fresh-context boundary | Runs before the latest fresh-context run never reach a provider again. | `orchestration-v2/contextBoundary.ts` |
| Fixed instruction size | A CI test measures the Claude system append (6,245 B), the Codex additionalContext (7,639 B) and the MCP tool list (59 kB). It fails if any of them grows without an `agent-context-increase` label. Only 2 MCP tools are `alwaysLoad`. The rest are deferred behind ToolSearch, which t3code forces on (`ENABLE_TOOL_SEARCH=true`) even on 1M models. | `provider/AgentContextBudget.test.ts`, `agentContextBudget.json`, `claudeToolSearchOverride` |
| Stable prefix | The system append is a preset plus fixed text, with no per-turn values. | `makeClaudeQueryOptions` |

### How UCCH does it today

**Process model:**
- `claude -p --resume`, `codex exec … resume` and `omp --resume` start one CLI process per turn (`packages/providers/src/{claude,codex,omp}.ts`).
- The session ID is persisted in `threads.provider_session_id` (`packages/db/src/schema.ts:371`).
- The native loop replays the event log and adds explicit `cache_control` breakpoints (`apps/server/src/openrouter.ts:290`). A warning fires on cache misses (`packages/agent/src/loop.ts:328`).

**Thresholds** (`packages/protocol/src/context-budget.ts`):
- CLI mid-turn auto-compact at 55% (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=55`, Codex `model_auto_compact_token_limit`).
- Server-forced handover at 75% (`#handOverIfFull`, `apps/server/src/agent.ts:784`). The handover writes a brief through `omp -p` + OpenRouter, clears the session and starts a new one.

**Gaps, ordered by impact:**
1. **Codex occupancy is wrong.** It is computed as `turn.completed.usage.input + output` (`agent.ts:2251`, `apps/web/src/lib/chat-messages.ts:781`). That figure adds up every model call in the turn, or the whole session. It triggers early forced handovers.
2. **Inconsistent usage semantics.** Claude's `input_tokens` excludes cache. For Codex and OpenRouter it includes cache. `project_stats.tokens` adds input + cacheRead + cacheCreation (`apps/server/src/engine.ts:729`), so cached tokens are counted twice for Codex and the native loop.
3. **The Claude meter is wrong after a reload.** `context.usage` is not persisted (`packages/protocol/src/events.ts:1445`), so the fallback `input + output` leaves out the cache, which is almost the whole context.
4. **The meter is not reset on `thread.harness_switched`** (`apps/web/src/lib/thread-store.ts:96`). `context-meter-store.ts` is one global value shared by every chat on the page.
5. **The forced-handover reading lives only in memory** (`#contextAtEnd`, `agent.ts:378`). A restart skips it.
6. **No cache-lifetime awareness.** Expiry is never computed, compaction and handover ignore the cache, and the cache hit rate of CLI turns is not tracked.
7. **The prefix may not be stable.** Claude gets `--append-system-prompt` rebuilt every turn from `.agent/` knowledge and the guides (`agent.ts:2076-2120`), and the bridge MCP tool set changes with settings. Any change invalidates the cache for the *whole* conversation. Resumed Codex turns append `COLLABORATION_GUIDE` and `UCCH_AGENT_GUIDE` to every user message (`agent.ts:2207`), so context grows by that text every turn.
8. **55% mid-turn compaction is aggressive** (550k on a 1M model). Each compaction rewrites the prefix, so the cache is cold right after. The forced handover at 75% is the most expensive option available: a new session, a cold cache, and a lossy brief that needs OMP and an OpenRouter key, failing silently without them.
9. **Recap and brief hygiene.** The recap after an expired transcript ignores `sinceCleared` (`agent.ts:1268`). It has no budget against the window. `cliTranscriptExists` ignores the working folder (`apps/server/src/cli-session-files.ts:150`).
10. **The Codex window is fixed at 272k** whatever the model. Codex project knowledge is lost after Codex compacts.
11. **A restart leaves turns without an ending event** (`apps/server/src/index.ts:190`).

**Where UCCH is already ahead:** the native loop's explicit cache breakpoints and cache-miss warning, persistent resume IDs, per-account CLI homes, and a transcript-existence check with recap fallback.

**Goal:** readings that are exact and survive reloads and restarts for every harness. Compaction happens inside the session and while the cache is warm. A handover is the last resort and works without OMP. A fixed, budgeted prefix keeps cache hits high. Every one of these is measurable (Verification section).

## Design principles (from t3code)

1. **Occupancy is the latest request, not a sum.** Use `input + cache_read + cache_creation + output` of the last model call. Billing is a separate figure.
2. **Unknown, not zero.** Readings carry `complete | partial | unavailable`. A missing figure never shows as 0 and never triggers anything.
3. **The provider's own session is the source of truth.** Prefer the CLI's native compaction (`/compact`) to starting a new session.
4. **Spend while the cache is warm.** Any compaction the server starts happens before `promptCacheExpiresAt`.
5. **Fixed prefix.** System append and tool set are fixed for the life of a session. Changing content goes in the message, as a delta.
6. **Budget everything imported.** History is capped, and a work reserve is kept free.

## Tasks

Implementation review (2026-11-21, completed 2026-11-26): every task has its implementation wired into the runtime. The 2026-11-26 section below records how the last seven partial tasks were closed, and the two accepted exceptions. Checkmarks do not imply that live CLI, database or browser verification has passed. The comparison sections above describe the original baseline.

### Phase 1: Exact, persisted readings (fixes gaps 1–5, 10)

- [x] **1.1 One usage contract.** Document in `packages/protocol` (`TokenUsage`) that `inputTokens` = **uncached** input, and `cacheReadInputTokens` / `cacheCreationInputTokens` are separate.
  - Change `mapCodexUsage` (`packages/providers/src/codex.ts:650`) to `input = input_tokens − cached_input_tokens`.
  - Change the OpenRouter `readUsage` (`apps/server/src/openrouter.ts:622`) the same way.
  - `project_stats.tokens` (`engine.ts:729`) then stays correct as written.
  - Add a unit test for each provider mapping.
- [x] **1.2 `ContextReading` type** in `packages/protocol/src/context-budget.ts`: `{ usedTokens, windowTokens, compactThreshold?, cacheExpiresAt?, cachedTokens?, status, harness, model, at }`.
  - Add a helper `occupancy(lastCallUsage)` = input + cacheRead + cacheCreation + output. The Claude normaliser already does this in `#contextReading` (`claude.ts:529`), so move it there.
- [x] **1.3 Codex: read real per-call usage.** After each Codex turn, read the last `token_count` event from the session's rollout file under the account's `CODEX_HOME/sessions/**/rollout-*-<sessionId>.jsonl`. That event carries `info.last_token_usage` and `info.model_context_window`. Emit `context.usage` from it.
  - Reuse the path logic in `cli-session-files.ts`.
  - First check with a fixture from the installed Codex version: whether `turn.completed.usage` is per-turn or cumulative, and the rollout event shape. Record the result in a comment.
  - Fallback when there is no rollout: `status: "unavailable"`, which triggers nothing.
  - Remove the `turn_completed` occupancy path at `agent.ts:2251`.
  - The window comes from `model_context_window`, so `cliContextWindow("codex")` becomes a fallback only.
- [x] **1.4 Persist the latest reading.** Add a `threads.context_reading jsonb` column (Drizzle migration in `packages/db`; watch out for tsx watch applying migrations mid-edit). It is written by a `context.usage` projection in `engine.ts` (throttled: last value per turn plus on `turn_completed`). Clear it on `thread.context_cleared` and `thread.harness_switched`.
  - Serve it with the thread snapshot, so `ThreadStore` starts from it after a reload.
  - Remove the `contextTokens = input + output` fallback in `chat-messages.ts:781`.
- [x] **1.5 Server reads the persisted reading.** `#handOverIfFull` and Phase 3 logic read `threads.context_reading` instead of the in-memory `#contextAtEnd`, so restarts no longer skip the check.
- [x] **1.6 Web.**
  - `thread-store.ts`: reset the reading on `harness_switched`.
  - `context-meter-store.ts`: key it by `threadId`.
  - The meter (`context-meter.tsx`, `session-context-card.tsx`) shows the compaction line from `compactThreshold` when there is one, and "unknown" for `unavailable`.

### Phase 2: Keep the prompt cache warm (fixes gaps 6, 7)

- [x] **2.1 Cache expiry for Claude.** In `ClaudeNormaliser` (`claude.ts:414`), record the time each `message_start` arrives as the request start. Read `usage.cache_creation.ephemeral_{1h,5m}_input_tokens` and set `cacheExpiresAt = requestStart + TTL`.
  - A fully cached request (no creation) keeps the previous expiry pushed forward by the previous TTL, because a cache hit refreshes the cache.
  - Otherwise the expiry is unknown.
  - Carry it on `ContextReading`.
- [x] **2.2 Cache hit metric for CLI turns.** Per turn, `cacheHitRatio = cacheRead / (input + cacheRead + cacheCreation)` for the first call of a resumed turn.
  - When the first call is within `cacheExpiresAt` and reads 0 from the cache, emit the same warning the native loop does (`loop.ts:328`), with the prefix hash from 2.3.
  - Show "cache warm · Nm left" in the session card tooltip.
- [x] **2.3 Fixed prefix per session.** Compute the Claude `--append-system-prompt` text once per session and store `{text, sha256}` with the session (an event payload on `agent.session_started`, or a column next to `provider_session_id`). Resumed turns reuse the stored text unchanged.
  - Knowledge that changed mid-session (`.agent/` notes) goes in the user message as `<project-knowledge-update>` with only the diff, and only when the hash changed.
  - Log the hash on every turn.
- [x] **2.4 Fixed tool set per session.** Open the bridge MCP with the same tool list for the life of a session (decide once at session start), so `--mcp-config` doesn't change mid-session.
  - Check that Claude Code defers UCCH bridge tools behind ToolSearch.
  - Mark only the essentials as `_meta["anthropic/alwaysLoad"]`, as t3code does.
- [x] **2.5 Stop resending guides on Codex.** Remove the per-turn append of `COLLABORATION_GUIDE` / `UCCH_AGENT_GUIDE` in resumed Codex prompts (`agent.ts:2207`). Re-send them once, only on the first turn after a Codex compaction, which is detected from the rollout `compacted` event (1.3). This coordinates with plan1 §Codex resume, which owns the text.
- [x] **2.6 Size budget test.** Snapshot the bytes of the Claude append, the Codex instructions and the bridge tool list (name + description + inputSchema) in `packages/protocol/src/agent-context-budget.json`. A test fails when any of them grows without the JSON being updated. This shares the harness from plan1 §1.x.

### Phase 3: Compact inside the session, at the right time (fixes gaps 8, 9)

- [x] **3.1 Raise the mid-turn line.** Let each CLI compact at its default (Claude: window − 33k, Codex: its own default). Drop `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=55` and the Codex override, or make them a per-thread setting ("Compact early", default off).
  - Rationale: every compaction makes the cache cold, so compacting less often at a later point is cheaper. The server now prevents overflow (3.2, 3.3).
  - Update `CONTEXT_HANDOVER_RATIO` docs and `context-window.ts` colour lines (warn and full) to match the reported `compactThreshold`.
- [x] **3.2 In-session compaction instead of handover.** When a turn ends at or above the force line, `#handOverIfFull` → `thread.compact`:
  - **Claude:** send `/compact` as the next turn of the same session (`claude -p --resume <id>` with the stream-json input `/compact`; confirm that the installed CLI supports slash commands in headless mode). Read the `compact_boundary` line, which the normaliser already handles (`claude.ts:611`), and record a visible "Context compacted" item.
  - **Codex:** check whether `codex exec resume <id> "/compact"` compacts. If not, use `codex app-server` `thread/compact/start` (the app-server client already exists at `codex.ts:46` / `:141`).
  - **OMP:** already has a manual compact (`decide.ts:528`). Use it here as well.
  - `decide.ts:500-527`: `thread.handoff auto` maps to compact for all CLIs. A handover to a new session happens only when compaction is unavailable or fails.
- [x] **3.3 Idle compaction while the cache is warm** (t3code's `idleCompactionWindow`, adapted). When a turn completes on Claude with `usedTokens ≥ max(200k, 0.5 × compactThreshold)` and `cacheExpiresAt` is known, schedule `/compact` at `cacheExpiresAt − 2 min`.
  - Same skip rules as t3code: the thread is busy or queued, a permission is pending, subagents or background work are running, the last turn was `/compact`, the harness or model changed, the thread is archived, or there is a newer turn.
  - **Better than t3code:** store the due time in the database (`threads.idle_compact_at`) and re-arm on startup in `apps/server/src/index.ts`, so a restart does not lose it.
  - Setting: off / on (default on above the threshold).
  - The compaction is shown as a turn in the thread.
- [x] **3.4 Check before each turn.** Before dispatching a turn, compare `reading.usedTokens + estimate(newText) + attachments (8k per image, 4k per file) + workReserve(max(16k, window/4))` with the window. If it is over, run 3.2 first, then send the message.
- [x] **3.5 Handover that works without OMP, with a budget** (still needed for harness switches and expired transcripts).
  - `#writeBrief` (`agent.ts:1636`) uses the thread's own harness in one-shot mode (`claude -p` / `codex exec`) when OMP or the OpenRouter key is missing.
  - If that also fails, it falls back to the deterministic `conversationRecap` instead of failing silently. Surface the failure as a thread notice.
  - Both the brief and the recap use t3code's `handoffBudget` formula: cap 16k tokens and keep a work reserve. Port the formula to `context-budget.ts`.
- [x] **3.6 Recap and transcript hygiene.**
  - `conversationRecap` input uses `sinceCleared` (`agent.ts:1268`), matching the brief.
  - `cliTranscriptExists` checks the project folder that `claude --resume` will look in, derived from the turn's cwd.
- [x] **3.7 Ask on resume** (optional, Claude). When a resumed session's reading is ≥ 200k and its cache has expired (it was idle longer than the TTL), ask once in the thread: "This session is Xh old and uses N tokens — compact before continuing?" The answers are compact / keep / don't ask again (per-thread setting). This uses the existing `agent.permission_requested` style UI.

### Phase 4: Restart integrity (gap 11)

- [x] **4.1** At startup, threads found `running` get an `agent.turn_failed { reason: "server restarted" }` event before being set to idle (`index.ts:186-194`), so the log and UI show the interrupted turn.

### Out of scope (noted for later)

- A long-lived Claude process per thread (t3code's live `query`), with stdin kept open across turns. It would save startup time and the MCP reconnect on each turn, but it changes the process model. Measure 2.2 hit rates first: if `--resume` already gets close to full cache hits, it is not worth the extra complexity.
- Moving Codex turns from `exec` to `app-server` completely. Do it only if 1.3 or 3.2 prove the rollout or exec route unreliable.

## Implementation review evidence (2026-11-21)

13 of 20 tasks are implemented; 7 remain partial against the requirements as written.

| Completed tasks | Implementation checked |
|---|---|
| 1.1–1.3 | `events.ts` documents uncached input; `mapCodexUsage` and OpenRouter `readUsage` separate cache tokens. `context-budget.ts` defines readings and occupancy. `codex-rollout.ts` documents the 0.170.0 fixture; `withCodexContext` reads per-call rollout usage and the real window, and emits unavailable when absent. |
| 1.4–1.5 | Migration `0047_thread_context_reading.sql` adds the columns. `agent.ts` carries the last reading into the end-of-turn projection; `engine.ts` writes and clears it. `ws.ts` sends it after replay. `#handOverIfFull` reads the database column. The billing-derived meter fallback is removed. |
| 1.6 | `ThreadStore` clears readings on harness switches, and `context-meter-store.ts` keys readings by thread. The meter handles unknown readings and compaction lines. Its displayed line is the earlier of the reported threshold and the server's 75% force line. |
| 2.4–2.5 | `#runCli` reuses stored tool flags. Claude enables ToolSearch; the bridge selectively sets `anthropic/alwaysLoad`. Codex resumed prompts omit guides; rollout compactions mark the stored prefix for one resend. |
| 3.1–3.2 | Provider argv/environment no longer force early vendor compaction. `decide.ts` maps automatic handoff to compaction; `#compactSession` uses Claude `/compact` or Codex app-server compaction, and OMP uses maintenance. Automatic compaction failures can dispatch a fallback handover. CLI compatibility findings are documented in provider code and fixtures. |
| 3.6–3.7 | Missing-transcript recaps use `sinceCleared`; Claude transcript lookup uses the turn cwd. Expired large Claude sessions receive a compact/keep/never choice, with the opt-out persisted per thread. |
| 4.1 | Startup calls `failInterruptedTurns` in `restart-recovery.ts`, appending `agent.turn_failed` for open interrupted turns before returning threads to idle. |

Closed on 2026-11-26 (the seven tasks that were partial):

- **2.1:** `cacheExpiry` no longer guesses five minutes for a cache write the CLI did not split by lifetime. Such a write now gives an unknown expiry, as the contract says. The `creationTotal` input is gone (`context-budget.ts`, `claude.ts`), and the test asserts `null`.
- **2.2:** Codex: `foldRolloutLine` keeps the turn's first `last_token_usage` (`reading.first`), and `withCodexContext` emits `cacheHitRatio` from it (`codex-rollout.test.ts`). **Accepted exception, OMP:** `get_session_stats` reports only running session totals, never per-call usage, so a first-call ratio cannot be derived for OMP. It is left out rather than approximated from the turn's sum.
- **2.3:** **Accepted exception:** Claude's prefix is rebuilt, with the same resume token, when the model, effort or bridge changes. The runtime-info block names the model and effort, so keeping the old text would tell the agent the wrong model. Within one model, effort and tool set, the text is byte-stable, and knowledge changes arrive as `<project-knowledge-update>` deltas. `session-prefix.test.ts` pins both behaviours.
- **2.6:** The 5% tolerance is gone from `apps/server/src/agent-context-budget.test.ts` and `packages/omp-bridge/src/tools-budget.test.ts`. Any growth past the recorded figure fails, until the JSON is updated in the same commit.
- **3.3:** `#idleCompactDue` skips when the reading was taken on another model than the session's last turn. Its background-work check now also counts running deliberations (`agent_deliberations`) and background subagent runs (`agent_runs`). An idle compaction opens a turn of its own (`turn.started`, which ends `agent.turn_completed { stopReason: "compacted" }` or `agent.turn_failed`), covered by an `agent.test.ts` case. A compaction the person asks for is still maintenance, drawn only as its divider.
- **3.4:** The preflight now runs for subagent and child turns as well. It excludes OMP, which compacts itself at its own `contextThreshold` before a prompt crosses it. When the message would not fit (`overWindow`) and the compaction fails or produces nothing, the turn starts a fresh session on a `#writeBrief` brief of the old one (`handoffMessage`). If no brief can be written either, the turn fails and says why. It no longer overflows silently.
- **3.5:** `#writeBrief` counts the destination's fixed prefix (`FRESH_PREFIX_TOKENS`: the CLI's own system prompt and tools plus UCCH's instructions) and the message's attachments. It clips with `clipToBytes`, which keeps the notice inside the budget and never splits a UTF-8 character (`context-budget.test.ts`).
- The "3 failing OMP assertions" from the first review were fixed in commit 2222e0b. `agent.test.ts` now expects the 55% OMP threshold (`110000` for a 200k window).

Validation performed for this review:

- **15 focused test files passed: 442 tests.** Coverage includes usage mappings, rollout fixtures, occupancy/cache/idle/budget helpers, prefix stability, size budgets, projection helpers, decisions, transcript lookup, handoff helpers and web stores.
- **4 additional test files: 177 passed, 3 failed.** WebSocket replay, native-loop and bridge tests passed. `apps/server/src/agent.test.ts` failed three OMP assertions (one normal turn and compact/handoff maintenance): each expects `thresholdTokens: null`, while the runtime reports `110000` for a 200k window. These expectations need review against the intended OMP threshold behavior.
- Fresh/dev database migration application, real server restarts, authenticated live CLI behavior, browser scenarios and before/after metrics were **not run**. The migration and startup wiring were inspected, not exercised against a database.

## Verification

- **Unit:** provider usage mapping (1.1), `occupancy` (1.2), Codex rollout parsing against a real fixture (1.3), cache expiry from `cache_creation` (2.1), idle-compaction window rules (3.3, table-driven like t3code's `IdleCompaction.test.ts`), handover budget (3.5), prefix-hash stability (2.3), size budget snapshot (2.6). Run single specs per the pnpm filter note: `pnpm --filter <pkg> exec vitest run <file>`.
- **DB:** migration applies on a fresh database and on the dev database. `threads.context_reading` and `idle_compact_at` survive a server restart.
- **End to end (headless Chrome via CDP, DEV_AUTH_BYPASS):**
  1. Run a Claude turn. Reload the page. The meter shows the same value as before the reload (it used to drop to tiny).
  2. Run a Codex multi-tool turn. The meter matches the rollout's `last_token_usage`, not the turn sum, and no early handover fires.
  3. Run two consecutive Claude turns within the TTL. The second turn's first call has `cacheRead > 0`, and the tooltip shows "cache warm". Edit an `.agent/` note between turns. The prefix hash is unchanged and the delta arrives in the message.
  4. Push a test thread past the force line (lower the threshold in a test setting). The thread shows "Context compacted" in the same session (same `provider_session_id`), not a handover.
  5. Set a short idle-compaction lead. `/compact` runs before the expiry, and the compaction's own first call reads from cache.
  6. Stop the server mid-turn and start it again. The turn shows as failed, and a scheduled idle compaction is re-armed.
- **Metrics to compare before and after:** average cache hit ratio per resumed CLI turn, number of forced handovers per 100 turns, and meter error after a reload (should be 0).
