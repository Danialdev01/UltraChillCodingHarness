# Plan 4: Reviewer and Council in the chat

## Context

**Request** (from `documentation/idea.md`, "agent"):
- **Reviewer:** after the agent answers, the system starts another subagent, on a different AI model, to re-evaluate that agent's work.
- **Council:** the AI discusses with several AI agents how to solve a problem, or what to think about a decision.
- Both run only when the user mentions them in a chat message. When the user names no model, UCCH either uses the current session's model or picks the best model available in the harness for the job.

**Decisions taken:**
- **The Reviewer reports, and a fix is one click away.** It is read-only. It posts a findings card, and a button sends the findings back to the original agent to fix. `@reviewer(fix)` does this automatically, once: fix, then one re-review.
- **The Council works in rounds with a moderator.** 2–5 members answer independently. They then critique each other for 1–2 rounds, stopping early on consensus. Finally the current chat agent (the moderator) writes the answer, noting consensus and dissent, and goes on to implement it if the user asked for that.

**What exists today, to reuse:**
- **Subagent spawning** (`apps/server/src/subagents.ts`, `SubagentRunner`):
  - Hidden child sessions through `thread.create` with `parentThreadId` (`:167`).
  - Quota and health-aware routing through `resolveHarness` (`packages/protocol/src/model-routing.ts:169`), plus one automatic CLI → OMP/OpenRouter fallback (`:284`).
  - Background mode with a completion `notify` (`:373`), and the usage-limit choice (`:315`).
  - Children cannot spawn children (`:127`, `decide.ts:221`).
- **Child cards** (`apps/web/src/components/subagent-card.tsx`): model, routing reason, transcript link and stop button. Lineage is in `lib/subagent-lineage.ts`.
- **Follow-up turns** to an existing child: `thread.send` with `subagentId` (`commands.ts:118-171`). Agent messages are attributed in chat by `AgentSessionMessage` (`subagent-card.tsx:438`).
- **Read-only turns:** plan mode's `draft` stage (`commands.ts:158`, `apps/server/src/plan-mode.ts`).
- **The end of a turn** is the `#run` `finally` in `apps/server/src/agent.ts:818-835`, which already schedules `messaging.deliver`. The `agent.turn_completed` event is at `events.ts:803`.
- **The handoff brief** (used by fallback and handoff) summarises a conversation for a new session.
- **Composer menus:** the `@` mention menu (`apps/web/src/lib/file-mention.ts`, which only handles files today), the `/` menu (`lib/slash-commands.ts`), and the shared popover (`components/composer-menu.tsx`).

**Gaps:**
- There is no way to start an agent from the server without the parent calling `ucch_agent`: `SubagentRunner.start` needs a claimed tool call.
- Models carry no metadata (no vendor, tier or strengths), so there is no "best model for the task".
- Mentions cover only files.
- The chat has no card for a verdict or a discussion.

**Naming:** "review" is already taken by the OMP code-review engine (`review.run`, the `reviews` table, `omp-review.ts`, the git review banner). In the interface the new features are **Reviewer** and **Council**. Internally they are **peer review** (`peer_review`) and **council**, so no event, table or route collides with `review.*`.

**Why `@` and not `/`:** the `/` menu runs commands in the browser, and an unknown `/word` reaches the CLI unchanged. Codex runs its own `/review` on it (`packages/providers/src/codex.ts:316`). An `@` directive is parsed and removed by UCCH and never reaches a harness.

## Design principles

1. **The server orchestrates; agents don't decide to do it.** The user's mention is parsed once by a shared pure parser and stored on `user.message`. The server then runs the reviewer or council deterministically. Turn counts, cost and timing are bounded by code, not left to the model.
2. **Built on the subagent machinery.** Every reviewer and council member is an ordinary hidden child session. It gets the same routing, quota checks, fallback, transcript link, stop button, credential source and "no grandchildren" rule as a `ucch_agent` child. Nothing about spawning is duplicated.
3. **Reviewers and members never write.** Their turns run in read-only mode on the parent's worktree. Only the original agent applies fixes.
4. **Model diversity by default.** "Auto" prefers a different vendor from the author for a reviewer, and the widest spread of vendors for a council. When nothing else is usable, it falls back to the session's own model and says so on the card.
5. **Bounded and cancellable:**
   - At most 3 reviewers, 5 council members and 3 rounds.
   - A per-run timeout and a per-run spend cap.
   - Stopping the parent turn, or the card's Stop button, cancels every child.
6. **Event-sourced like everything else.** Every step goes through command → `decide` → events → projection → reactors, so the card can be rebuilt after a reload, and an interrupted run is marked failed on startup, as `messaging.recover()` already does.
7. **Context budget:** the extra instructions go into the child's first message (the task), never into the parent's fixed per-turn prefix. The parent's prefix only gains the moderator brief on the council-synthesis turn. Covered by `agent-context-budget.test.ts`.

## Mention syntax

```
@reviewer                       review the answer this message produces (or, if the message is only this, the previous answer)
@reviewer(gpt-5)                use this model (any name parseModelRequest understands)
@reviewer(opus, gpt-5)          two reviewers in parallel (max 3)
@reviewer(fix)                  automatic fix, then one re-review
@reviewer(gpt-5, fix)           options and models can be mixed

@council should we move sessions to Redis?
@council(opus, gpt-5, gemini-2.5-pro)    named members (2–5)
@council(4)                     4 members, models chosen automatically
@council(rounds=2)              discussion rounds after the opening answers (0–3, default 1)
@council(implement)             after the conclusion, the moderator goes on to implement it
```

- **Parsing:** inside the parentheses, a token that matches an option (`fix`, `implement`, `rounds=N`, a bare count) is an option. Everything else is a model request, resolved through `parseModelRequest` and `resolveHarness`.
- **Bad input:** an unknown model, or more than the maximum, refuses the send with an inline error under the composer. It is never silently ignored.
- **Position:** a mention can go anywhere in the message. Mentions are removed from the text the agent sees and replaced with a single space.
- **One of each:** each message can hold one `@reviewer` and one `@council`. With both, the council runs first, and the reviewer then reviews the moderator's resulting answer.
- **No question:** `@council` with no other text is refused with the hint "Ask the council a question".

## Tasks

### Phase 1: Protocol (shared, pure)

- [x] **1.1 `packages/protocol/src/agent-directives.ts`** (plain, so the browser can import it from `@ucch/protocol/plain`).
  - **Contents:**
    - `parseDirectives(text) → { text: string /* mentions removed */, reviewer?: ReviewerDirective, council?: CouncilDirective, errors: DirectiveError[] }`.
    - `ReviewerDirective = { models: string[]; fix: boolean; previous: boolean }`. `previous` is true when the message holds nothing else.
    - `CouncilDirective = { models: string[]; size: number | null; rounds: number; implement: boolean }`.
    - Limits are exported constants: `PEER_REVIEW_MAX_REVIEWERS = 3`, `COUNCIL_MIN = 2`, `COUNCIL_MAX = 5`, `COUNCIL_MAX_ROUNDS = 3`, `COUNCIL_DEFAULT_SIZE = 3`, `COUNCIL_DEFAULT_ROUNDS = 1`.
  - **Rules:**
    - Case-insensitive.
    - A mention must be preceded by the start of the text or by whitespace, so `me@reviewer.com` is not one.
    - Mentions inside code fences and inline code are ignored.
    - It returns character ranges so the composer can highlight the mentions.
  - **Why share it:** the web uses it for chips and inline errors, the server for the authoritative decision, so the two can't disagree.

- [x] **1.2 `packages/protocol/src/model-profiles.ts`**: model metadata for picking the "best model".
  - `ModelProfile = { family: string; vendor: "anthropic" | "openai" | "google" | "xai" | "deepseek" | "other"; tier: 1 | 2 | 3; strengths: ("code" | "review" | "reasoning" | "long-context" | "fast")[] }`. Tier 1 is the frontier models.
  - A small hand-maintained table keyed by family pattern, covering the models the providers list today (`packages/providers/src/claude.ts:55`, `codex.ts:44`) and the common OpenRouter families.
  - Unknown models get `{ vendor: from the id prefix, tier: 3, strengths: [] }`.
  - **`pickModels({ role, author, count, explicit, available, preference })`, a pure function:**
    - `available` is the routing harness list that `#routingHarnesses` (`agent.ts:479`) already builds: healthy, at or below 90% quota, with authoritative model lists, plus the OpenRouter catalogue when OMP is configured.
    - `preference` is `"auto" | "same" | modelId`, from Phase 4.4.
    - **`role: "reviewer"`:** the highest-tier model with the `review`/`code` strength from a **different vendor** than the author. Failing that, the same vendor but a different family. Failing that, the author's own model.
    - **`role: "council"`:** seat 1 is the author's model (the moderator's own view). The remaining seats go round-robin across vendors by tier, never reusing a model id before every vendor is used.
    - Explicit models always win, and fill seats first.
    - It returns `{ model, reason }[]`. `reason` ("different vendor from the author", "same model: nothing else available", "you asked for it") goes on the card, like `routing.label`.
  - **Unit tests:** diversity, explicit override, the fallback chain, determinism (sorted, no randomness).

- [x] **1.3 Commands** (`packages/protocol/src/commands.ts`):
  - `thread.send` gains **no new user field**. The server parses directives from `text`, so every client (web, API, mobile) gets the same behaviour.
  - New internal-only fields on `thread.send`, the same pattern as `agentMessageIds` (`decide.ts:336`):
    - `peerReviewId?`: a fix turn that carries findings.
    - `councilId?`: the moderator's synthesis turn.
  - **`thread.peer_review`** `{ threadId, turnId?, models?, fix? }`: a user command for the card's "Review again" and "Review with…" buttons. It needs `exec` scope.
  - **`thread.peer_review_fix`** `{ threadId, peerReviewId, findingIds? }`: the "Ask agent to fix" button.
  - **`thread.deliberation_cancel`** `{ threadId, deliberationId }`.

- [x] **1.4 Events** (`packages/protocol/src/events.ts`). Every event carries `deliberationId` and `threadId` (the parent).
  - **On `user.message`:** an optional `directives?: { reviewer?, council? }`. It holds the normalised directive, not the raw text, and is optional so old events still read.
  - **Peer review:**
    - `agent.peer_review_started { reviewers: { subagentId, childThreadId, model, provider, reason }[], targetTurnId, fix }`
    - `agent.peer_review_completed { subagentId, verdict: "approve" | "changes_requested" | "incorrect", summary, findings: Finding[], costUsd }`
    - `agent.peer_review_failed { subagentId, error }`
    - `Finding = { id, severity: "critical" | "major" | "minor" | "nit", file?, line?, title, detail }`
  - **Council:**
    - `agent.council_started { members: { seat: "A".."E", subagentId, childThreadId, model, provider, reason }[], rounds, question }`
    - `agent.council_position { round, seat, recommendation, confidence: 0..1, reasons: string[], risks: string[], changed: boolean }`
    - `agent.council_concluded { consensus: "unanimous" | "majority" | "split", recommendation, dissent: { seat, position }[], roundsRun, costUsd }`
    - `agent.council_failed { error, partial: boolean }`
  - **Ending:** `agent.deliberation_cancelled { by: "user" | "parent" | "budget" | "timeout" }`.
  - All of these go into the `DomainEvent` union, and into `isTransient` = false, because they are persisted.

- [x] **1.5 Protocol tests:**
  - `agent-directives.test.ts`: the grammar table, code-fence exclusion, email false positives, limits, error messages.
  - `model-profiles.test.ts`.

### Phase 2: Server: running children without a tool call

- [x] **2.1 `SubagentRunner.startManaged(request)`** (`apps/server/src/subagents.ts`). This is a server-initiated entry point next to `start`.
  - It **skips `claimCall`**. It is placed on the triggering turn through a `placement: { turnId, kind: "peer_review" | "council", deliberationId }` argument, so `agent.subagent_started` is still emitted and the existing child card and lineage rail work without changes.
  - It takes `readOnly: true` (task 2.2) and `resolvedModel` (from `pickModels`; it still goes through `resolveHarness` for the harness).
  - It is always background mode, but `notify` is replaced by a returned promise that resolves with the child's final assistant text, `costUsd` and status. This reuses `#childTurn` (`:385`).
  - Refactor the shared body of `start` (from model resolution to `thread.send`) into a private `#launch` that both entry points call. There is no copy-paste.
  - `followUp(childThreadId, text)`: a follow-up turn on the same child, used for council rounds, so each member keeps its own context and its prompt cache. It reuses the `thread.send` + `subagentId` path (`commands.ts`).

- [x] **2.2 Read-only turns for reviewers and members.**
  - Reuse plan mode's `draft` read-only enforcement (`apps/server/src/plan-mode.ts`).
  - **Check each harness first:**
    - Claude Code: permission mode `plan`, or a tool allowlist without Edit/Write/Bash writes.
    - Codex: `sandbox: read-only`.
    - OMP and native: the registry tool filter (`packages/agent/src/registry.ts:268` shows the pattern).
  - Add a `readOnly` flag to `thread.send` (server-only) that maps to whichever of these each harness uses.
  - **Test:** a reviewer asked to "fix this typo" cannot change the worktree.

- [x] **2.3 Turn snapshot for review context.**
  - At turn start, when `directives.reviewer` is set, record `{ head: git rev-parse HEAD, stash: git stash create || head }` for the parent's worktree in memory, keyed by turn id. Recording it only on request keeps every other turn fast.
  - At turn end, compute `git diff <stash>` (working tree against the turn-start state, including uncommitted and new files), plus `git diff --stat`.
  - Reuse the existing git helpers that the git view uses. Run them as argv, with no shell.
  - **Size cap:** if the diff exceeds 40 kB, include only the `--stat` and the list of changed files, and tell the reviewer to read the files itself (it has read tools). This keeps the task under the 60k `task` limit.
  - When `previous` is set (`@reviewer` alone), there is no snapshot. The review covers the previous turn's answer and its recorded tool-call file list.

- [x] **2.4 Directive parsing in `decide()`** (`apps/server/src/decide.ts`).
  - `thread.send` from a user runs `parseDirectives`.
  - When `errors` is not empty, the send is refused with the first error's message. The web shows it inline before sending; this is the authoritative copy.
  - `user.message` stores the stripped `text` plus `directives`.
  - A child thread (one with `parentThreadId`) refuses directives: "Reviewer and Council run from the main session". This mirrors the no-grandchildren rule.
  - `decide.test.ts` gets table rows for each of these.

- [x] **2.5 Migration `0051_agent_deliberations.sql`** (planned as `0048`; three other migrations landed first) plus the schema (`packages/db/src/schema.ts`, next to `agent_runs` at `:1227`).
  - `agent_deliberations`:
    - `id` (uuid), `thread_id`, `project_id`, `kind` (`peer_review | council`), `turn_id`
    - `status` (`running | completed | failed | cancelled`)
    - `directive` (jsonb), `members` (jsonb), `result` (jsonb: verdict and findings, or the conclusion)
    - `cost_usd`, `created_at`, `finished_at`
  - Indexes on `(thread_id, created_at)` and on `status`, filtered to `running`.
  - Engine projection (`apps/server/src/engine.ts`, next to the `agent_messages`/`agent_runs` projection at `:508`): `*_started` inserts a row, positions and completions update `result`, and terminal events set `status`/`finished_at`.
  - Council positions are stored in `result.rounds[]`, so the card can rebuild every round after a reload.

### Phase 3: Server: the two orchestrators

- [x] **3.1 `apps/server/src/peer-review.ts`: the `PeerReviewer` class.**
  - **Trigger:** in `agent.ts` `#run` `finally` (`:818-835`), when the turn ended `agent.turn_completed` (not failed or cancelled) and the turn's `user.message` carried `directives.reviewer`, call `peerReviewer.run({ threadId, turnId, directive, snapshot })`. A failed or cancelled turn appends `agent.peer_review_failed { error: "the answer did not finish" }` instead. For `previous`, the trigger is immediate and no parent turn runs: `decide` emits `user.message` and the reactor starts the review.
  - **Choosing models:** `pickModels({ role: "reviewer", author: <model of the turn being reviewed>, count: max(1, models.length), explicit: models, preference })`.
  - **Task text** (a fixed template constant, `PEER_REVIEW_BRIEF`, under the 1,500-byte block budget):
    1. Role: an independent reviewer from a different model, read-only, verifying rather than rewriting.
    2. `<request>`: the user's original message, with mentions removed.
    3. `<answer>`: the author's final assistant text, capped at 12 kB.
    4. `<changes>`: the diff or stat from task 2.3.
    5. What to check: correctness against the request, bugs, missed requirements, security, tests run or not, and claims in the answer that aren't true.
    6. The output contract: end with exactly one fenced `ucch-review` JSON block holding `{verdict, summary, findings[]}`. File paths are relative to the worktree, and every finding needs a concrete reason.
  - **Parsing:** `parseReviewBlock(text)` takes the last `ucch-review` block, validates it with zod, keeps at most 30 findings and gives them stable ids. If the block is missing or invalid, it falls back to `verdict: "changes_requested"`, `summary` = the first 600 characters of the text, `findings: []`, and `rawText: true`, so the card still shows the text.
  - **Parallel reviewers:** run them with `Promise.allSettled`. Each completes on its own and the card fills in as they finish.
  - **`fix: true`:**
    1. When every verdict is `approve`, stop.
    2. Otherwise dispatch `thread.peer_review_fix` with all findings that are `critical`/`major`/`minor` (nits are dropped).
    3. That fix turn ends, and **one** re-review runs with the same reviewer model(s) and `fix: false`.
    4. The loop is hard-capped: an automatic fix never triggers another automatic fix.
  - **`thread.peer_review_fix` reactor:** dispatches `thread.send` to the parent with `peerReviewId` and a `PEER_REVIEW_FIX_BRIEF` text. The text lists the findings and tells the agent to verify each one, fix the valid ones, say which it rejects and why, and run the relevant tests. The chat renders this turn's user bubble as "From Reviewer (GPT-5)", reusing the `AgentSessionMessage` attribution style.
  - **Limits:**
    - A per-reviewer timeout of `PEER_REVIEW_TIMEOUT_MS = 15 min`.
    - A spend cap of `PEER_REVIEW_MAX_COST_USD` (env, default 2.00), taken from the child turn's `costUsd`. Exceeding it cancels the child and ends with `agent.deliberation_cancelled { by: "budget" }`.

- [x] **3.2 `apps/server/src/council.ts`: the `CouncilRunner` class.**
  - **Trigger:** when a `user.message` carries `directives.council`, the parent's normal turn is **held back**. `decide` marks the turn `awaitingCouncil`, and the scheduler doesn't start it. `CouncilRunner.run(...)` starts instead.
  - **Seats:** `pickModels({ role: "council", author: <session model>, count: size ?? max(models.length, COUNCIL_DEFAULT_SIZE), explicit: models, preference })`. Seats are labelled A–E. Members see only the labels, never the other members' model names, which avoids brand bias. The card shows the models.
  - **Context:** `<question>` (the stripped message), plus `<context>` from the existing **handoff brief** of the parent conversation (capped at 8 kB). Members have read-only access to the worktree, so they can inspect code themselves.
  - **Round 0 (opening):** all members run in parallel with `COUNCIL_OPENING_BRIEF`: think independently, and end with a `ucch-position` block `{recommendation, confidence, reasons[], risks[]}`. Each result becomes `agent.council_position { round: 0 }`.
  - **Rounds 1..R (discussion):** each member gets a `followUp` on its own child session, holding the other members' latest positions under their seat labels, with `COUNCIL_ROUND_BRIEF`: critique the others, concede or hold, and set `changed`.
  - **Early stop:** stop when no member changed position in a round, or when every confidence is ≥ 0.8 and the recommendations match after normalising: lower-cased, then compared on the first 80 characters. When the comparison is unsure, carry on to the round cap.
  - **Concluding:**
    - Group members by recommendation: unanimous, majority, or split.
    - Append `agent.council_concluded`.
    - Release the held parent turn with `councilId` and a `COUNCIL_MODERATOR_BRIEF` added to that turn's message (not to the fixed prefix). It holds the user's question, each seat's final position with its model, and the consensus label. It tells the moderator to give the user a final answer that names the consensus, the strongest dissent and its own view.
    - With `implement`, the brief adds: "then carry out the recommended approach". Without it: "do not change files; answer only".
  - **Degraded runs:**
    - A member that fails or times out is dropped and reported in `council_concluded` (`partial`).
    - If fewer than 2 members remain after round 0, the run fails with `agent.council_failed { partial: true }`, and the parent turn still runs with a note saying the council could not meet.
  - **Limits:**
    - The whole council has a `COUNCIL_TIMEOUT_MS = 30 min` and a `COUNCIL_MAX_COST_USD` (env, default 5.00) across all members.
    - The members' turns take ordinary scheduler slots, so a council can't starve other sessions.

- [x] **3.3 Cancellation and recovery.**
  - `thread.cancel` on the parent (it already cancels children at `agent.ts:618-626`) and `thread.deliberation_cancel` both abort every child of the deliberation and append `agent.deliberation_cancelled`. When a council is cancelled, the held parent turn is dropped too.
  - On startup, next to `messaging.recover()` (`agent-messaging.ts:190`), mark `running` deliberations `failed { error: "server restarted" }` and release any held council turn with a note. Nothing re-runs by itself.

- [x] **3.4 Wiring** (`apps/server/src/index.ts`, where `SubagentRunner` and messaging are constructed, `agent.ts:444-462`):
  - Construct `PeerReviewer` and `CouncilRunner` with the runner, the store, `dispatch`, the git helpers and `#routingHarnesses`.
  - Register their reactors in the reactor composition (`index.ts:726-730`).
  - Add the new env vars (`PEER_REVIEW_MAX_COST_USD`, `COUNCIL_MAX_COST_USD`) to the config parser and to the README env table.

- [x] **3.5 Server tests**, which follow `subagents.test.ts` and `agent-messaging.test.ts` with a fake runner:
  - **Peer review:**
    - It triggers only on a completed turn.
    - The model choice prefers another vendor.
    - Block parsing, including the fallback.
    - `fix` runs exactly one fix and one re-review, and never loops.
    - The budget cancel.
  - **Council:**
    - The parent turn is held, then released.
    - Seats are anonymised in member prompts.
    - Early stop on no change.
    - A member failing still produces a conclusion.
    - Fewer than 2 members means failure, and the parent still answers.
  - **Recovery:** a running deliberation is marked failed after a restart.
  - **Read-only:** a reviewer's attempted write is refused on each harness, with one test per harness adapter.
  - **Context budget:** the briefs stay under their entries in `agent-context-budget.json` (run with `UCCH_UPDATE_CONTEXT_BUDGET=1` once).

### Phase 4: Web UI

- [x] **4.1 Composer mentions** (`apps/web/src/lib/file-mention.ts` → generalised into `lib/composer-mention.ts`).
  - The `@` menu lists **Reviewer** and **Council** above the file results, filtered by what has been typed. Each row has a one-line description and an icon.
  - Choosing one inserts `@reviewer` / `@council` and opens a second step listing the models (the same merged catalogue `project-chat.tsx:418-433` builds), plus "Auto (best available)" and "Same as this session". Several models can be picked, up to the limit. It writes `@reviewer(gpt-5, opus)`.
  - Highlight the mentions in the draft using the ranges from `parseDirectives`, and show the inline `errors` under the composer. Send is disabled while an error is present.
  - The `/` menu (`lib/slash-commands.ts`) gets `/reviewer` and `/council` entries that **insert the `@` mention** and never send a slash. They are listed so people can find them.
  - Tests: extend `slash-commands.test.ts` and `file-mention.test.ts` (renamed to `composer-mention.test.ts`).

- [x] **4.2 `components/peer-review-card.tsx`**, rendered under the answer it reviews, through `chat-messages.ts` handling the `agent.peer_review_*` events, as `isSubagentCall` does today (`chat-messages.ts:93`).
  - **Header:** a verdict badge (Approved / Changes requested / Incorrect), the reviewer's model icon and name, the `reason`, cost, and a transcript link (`useSessionHref`, `subagent-card.tsx:176`).
  - **Body:** the summary, then the findings grouped by severity. A `file:line` opens the file in the editor view where the project has one. Each finding has a checkbox, all checked by default.
  - **Actions:**
    - **Ask agent to fix (n):** dispatches `thread.peer_review_fix` with the checked ids.
    - **Review again:** with the same model.
    - **Review with…:** a model picker.
    - **Dismiss:** collapses the card.
    - **Stop**, while the review is running.
  - **While running:** a skeleton row per reviewer (no spinner and no "Loading…", per the `apps/web/CLAUDE.md` rule). Several reviewers show as tabs or stacked sections.
  - **Colours:** tokens only (`ui-color-lint.test.ts`).

- [x] **4.3 `components/council-card.tsx`**, rendered in place of the held turn while the council runs, then above the moderator's answer.
  - **Member strip:** seat letter, model icon, status (thinking / answered / dropped) and the transcript link.
  - **Rounds:** each round is a collapsible section with every seat's recommendation, a confidence bar, and its reasons and risks. A "changed position" marker shows when a member moved.
  - **Conclusion row:** a consensus badge (Unanimous / Majority / Split), the recommendation, and dissent callouts.
  - **Footer:** cost and rounds run, plus Stop while the council is running.
  - **Mobile:** works at 375 px, and the member strip wraps.

- [x] **4.4 Settings: the default model when none is named.**
  - In the project manage page's agent settings, and as a per-user default through `lib/model-preference.ts`:
    - **Reviewer model:** Auto (default) · Same as session · a specific model.
    - **Council size:** 2–5 (default 3).
    - **Council rounds:** 0–3 (default 1).
  - Stored server-side with the project settings, so it works from any device. `pickModels` reads it as `preference`.
  - These implement the request's "same model or best model" rule: Auto picks the best model available, and "Same as session" uses the session's own model.

- [x] **4.5 E2E** (`apps/web/e2e/peer-review.spec.ts`, `council.spec.ts`), using the fake-provider setup `subagent.spec.ts` uses:
  - Typing `@rev` shows the menu.
  - Sending `do X @reviewer` → an answer, then a review card with findings → Ask agent to fix → a fix turn attributed to the Reviewer.
  - `@council` → a card with 3 seats and rounds → the moderator's answer below it.
  - Stop cancels the run.
  - Reloading the page rebuilds both cards.

### Phase 5: Documentation

- [x] **5.1 `documentation/agent-coordination.md`:** a "Reviewer and Council" section covering the syntax, the model choice, the read-only rule, limits, costs and cancellation.
- [x] **5.2 `documentation/architecture.md`:**
  - The deliberation events and table, and the held-turn mechanism for the council.
  - How this differs from the OMP code review (`review.*`).
  - Fix the stale migration count at `:230`.
- [x] **5.3 `documentation/spec.md`:** the composer mentions and the two cards.
- [x] **5.4 `README.md`:** the new env vars.

## Completion notes (2026-11-26)

- **3.5:** Most server tests were already in `apps/server/src/deliberations.test.ts`. The gaps were filled as follows:
  - `reviewAfterTurn`, the gate that reviews only a completed turn and turns a failed one into `peer_review_failed`, is tested on its own.
  - The read-only denial is tested end to end on OMP under Strict (`agent.test.ts`). Claude's plan mode with its held-back tools and Codex's `read-only` sandbox were already covered in `claude.test.ts` and `codex.test.ts`.
  - The five briefs have entries in `agent-context-budget.json` and fall under the 1,500-byte block limit.
  - A held council turn after a restart is released by the startup sweep that releases every `queued` thread (`index.ts`, `turn.dequeued { reason: "restart" }`). There is no separate path to test.
- **3.2 / 4.4 preference:** The council takes no model preference, by design. Seat A is the author's model and the other seats are picked for vendor spread. The project setting covers the reviewer's model, the council's size and the council's rounds.
- **4.1:** The agent mentions live in a new `lib/composer-mention.ts`, beside `file-mention.ts` rather than replacing it. The file mention is unchanged, and the `@` menu shows both.
- **4.4:** The settings are a section on Manage → Preferences (`deliberation-settings.tsx`). Like the other sections there, it reads and writes `/api/projects/:hash/deliberation` directly (`lib/deliberation-api.ts`).
- **4.5:** The specs play the thread's events back over the real socket (`e2e/deliberation-playback.ts`) and catch the commands the cards send, so no model runs. Both pass. They cover the menu, inline errors, the cards, Fix, Stop and reload, plus a 375 px overflow check on the council card.
- **Not run:** the live checks in the Verification section, with signed-in Claude Code and Codex accounts on real models.

## Critical files

- **Protocol:** `packages/protocol/src/agent-directives.ts` (new), `model-profiles.ts` (new), `commands.ts`, `events.ts`, `plain.ts` (exports)
- **Server:** `apps/server/src/peer-review.ts` (new), `council.ts` (new), `subagents.ts` (`startManaged`, `#launch`, `followUp`), `agent.ts` (the `#run` finally hook, the held council turn, read-only mapping), `decide.ts`, `engine.ts`, `plan-mode.ts`, `index.ts`, `agent-context-budget.json`
- **Database:** `packages/db/migrations/0051_agent_deliberations.sql` (new), `packages/db/src/schema.ts`
- **Web:** `apps/web/src/lib/composer-mention.ts` (from `file-mention.ts`), `lib/slash-commands.ts`, `lib/chat-messages.ts`, `components/project-chat.tsx`, `components/composer-menu.tsx`, `components/peer-review-card.tsx` (new), `components/council-card.tsx` (new), `lib/model-preference.ts`

## Reuse, don't rebuild

- **Spawning, routing, quota and fallback:** `SubagentRunner` (`apps/server/src/subagents.ts`), `resolveHarness` / `parseModelRequest` (`packages/protocol/src/model-routing.ts`), `#routingHarnesses` (`agent.ts:479`), `SubscriptionQuotaService` (`quotas.ts`)
- **Following a child to completion:** `#childTurn` (`subagents.ts:385`)
- **Read-only turns:** plan mode `draft` (`plan-mode.ts`)
- **Conversation summary for members:** the handoff brief (the one the fallback in `subagents.ts:284` already uses)
- **Startup recovery:** the pattern in `messaging.recover()` (`agent-messaging.ts:190`)
- **Cards:** `SubagentCard`'s `Run` row, `useSessionHref`, the stop action, and `AgentSessionMessage` attribution (`subagent-card.tsx`)
- **Composer:** `ComposerMenu` / `MenuRow` (`composer-menu.tsx`), `trackMenus` (`project-chat.tsx:1184`), and the merged model catalogue (`project-chat.tsx:418`)

## Out of scope (possible follow-ups)

- Agents calling Reviewer or Council themselves (an `ucch_review`/`ucch_council` tool).
- An "always review every turn" project toggle.
- Reviewing a range of past turns or a whole branch. The git view's OMP review already covers branches.
- Weighted voting, or members with personas.

## Verification

1. **Unit:** `pnpm --filter @ucch/protocol test` (directives grammar, `pickModels`) and `pnpm --filter @ucch/server test` (peer review, council, decide rows, recovery, context budget). Run one spec at a time with the filter form, not `pnpm test -- X` (memory: pnpm `--` filter pitfall).
2. **Type check:** `tsc-rs`, with `tsc` as the backup (`documentation/type-checking.md`).
3. **E2E:** `apps/web/e2e/peer-review.spec.ts` and `council.spec.ts`, one at a time.
4. **Live, in the dev stack, with Claude Code and Codex both signed in:**
   - On a Claude session, run `add input validation to the signup route @reviewer`. Check that:
     - The reviewer runs on a GPT model, and the card's reason says "different vendor".
     - The findings refer to real lines in the diff.
     - "Ask agent to fix" starts an attributed fix turn.
     - The reviewer's transcript shows no file writes.
   - `@reviewer(fix)`: exactly one fix turn and one re-review, and no third turn.
   - `@council(3, rounds=2) should sessions move to Redis?`: 3 seats across vendors, rounds visible, early stop when positions hold, and the moderator's answer names the consensus and the dissent. Check that no files changed without `implement`.
   - Stop mid-council: every child stops, and the card shows Cancelled.
   - Drive a quota above 90% (or turn a provider off): Auto falls back to another model, or to the same model, and the card says so.
5. **Browser:** check the composer menu, both cards and the settings at 375 px and in both themes, with Claude in Chrome, or headless CDP when the extension is down (memory: headless-browser-verification). Skeletons show while loading, and the layout doesn't jump.
6. **Restart:** kill the server mid-council. On boot the deliberation shows as failed, and the held turn is released with a note.
