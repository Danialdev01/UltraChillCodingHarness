# Cross-harness agents and project messages

Ask any chat harness to start agents on named models. `ucch_agent` prefers Claude Code for Claude models and Codex for OpenAI models. Other models run on OMP using the configured OpenRouter key.

Before spawning, UCCH checks the billing subject's harness health, authoritative model catalogue when available, and subscription usage. Every applicable window must be at or below 90%; exactly 90% remains eligible. Claude model-specific weekly buckets apply to their model family. Quota lookups are coalesced and cached for 60 seconds per credential subject and provider. Unknown usage permits a CLI attempt. Static model-picker choices are not availability restrictions.

Unavailable subscriptions, inaccessible models, and subscription limits automatically fall back to the same model through OMP/OpenRouter. OpenRouter calls are billed to the configured key. Missing OMP configuration or ambiguous/unavailable models produce actionable errors rather than substituting a model version. A runtime fallback preserves the child session and uses the existing handoff brief. There is one automatic CLI-to-OpenRouter transition; recovery choices remain available after a fallback limit.

## Background work

Set `background: true` to receive the child session ID immediately and continue working. Omitting it preserves blocking behavior. Children share their parent's worktree and credential source. Normal parent-turn completion and bridge disconnection leave background children running. Explicit parent cancellation stops its children; a child's stop action affects that child alone. Children cannot recursively spawn more children.

Child cards show the selected model, routing reason, subsequent harness changes, background status, transcript link, and a stop action. Completion sends a persistent message to the parent. Finish your turn when waiting for children so scheduler slots stay available.

## Communication tools

| Tool | Purpose |
| --- | --- |
| `ucch_sessions` | Discover nonarchived sessions and children in the current project, including model, harness, lineage, and status. |
| `ucch_message` | Send `text` to a `sessionId`; include an incoming `replyTo` message ID when replying. |
| `ucch_inbox` | Read the session's mailbox, using the returned `cursor` for subsequent pages. |
| `ucch_agent_status` | Inspect a child by `sessionId`. |
| `ucch_agent_cancel` | Stop a child by `sessionId`. |

These tools work through Claude/Codex MCP bridges, OMP host tools, and the native loop. Children receive messaging tools without the spawn tool. Sender identity comes from the running session; sessions cannot address another project or borrow another session's credentials.

Messages are durable events with a database inbox projection. Idle recipients wake automatically on their own configured harness/model and billing subject. Busy recipients receive a batched follow-up turn after active work completes; a managed child finishes its assigned task and any fallback before accepting follow-up turns. Chat shows agent attribution, session links, and delivery status. Delivery means the message was committed into the recipient's conversation, not that its task succeeded.

Receipts and the follow-up conversation message commit atomically with the turn claim. Explicit cancellation pauses automatic delivery until a user resumes the recipient. Reply chains carry an eight-hop automatic-delivery budget, including replies that omit `replyTo`; further messages remain in the inbox for user continuation. Agent messages are task data rather than user/system instructions and do not require automatic acknowledgments.

Migration `0036_agent_collaboration` adds inbox/run projections and the persisted delivery pause. Startup marks interrupted child runs failed instead of restarting their work, then schedules eligible pending inbox messages. Existing events and blocking callers remain compatible.

## Reviewer and Council

A person can ask for a second opinion in the message itself. The server runs both features; the agent never decides to start them (plan4).

| Mention | Does |
| --- | --- |
| `@reviewer` | After this message's answer, another model reviews it. Alone in a message, it reviews the previous answer. |
| `@reviewer(gpt-5, opus)` | Named reviewers, up to 3, in parallel. `same` is the session's own model. |
| `@reviewer(fix)` | Sends the findings back to the agent once, then reviews the fix once. A fix never triggers another fix. |
| `@council <question>` | 2–5 models answer the question, critique each other, and then the session's agent (the moderator) answers, naming the consensus and the dissent. |
| `@council(4)`, `@council(rounds=2)`, `@council(opus, gpt-5)` | Size, discussion rounds (0–3), or named members. |
| `@council(implement)` | Once the council concludes, the moderator carries the recommendation out. Without it, the moderator changes no files. |

- **Parsing.** `parseDirectives` (`packages/protocol/src/agent-directives.ts`) is shared by the composer, which highlights mistakes and blocks Send, and by `decide()`, whose reading is authoritative. Mentions are removed before any harness sees the text. Mentions in code are ignored, and `me@reviewer.com` is not a mention. Child sessions refuse mentions.
- **Choosing models.** `pickModels` (`model-profiles.ts`): named models take the first seats. Auto picks a reviewer from a different vendor than the author, then a different family from the same vendor, and as a last resort the author's own model. The card says which rule applied. A council's seat A is the author's model, and the other seats rotate across vendors. A project sets the defaults on Manage → Preferences → Reviewer and Council: the reviewer model (Auto, Same as the session, or a specific model), the council size and the council rounds.
- **Read-only.** Reviewers and members are ordinary hidden child sessions (`SubagentRunner.startManaged`), with the same routing, quota checks, fallback, transcript links and stop button as `ucch_agent` children. Their threads are `readOnly`: Claude Code runs in plan mode with write tools held back, Codex uses the `read-only` sandbox, the native loop uses its read-only preset, and any write prompt is denied in the reactor (`READ_ONLY_DENIAL`) rather than asked of a person. Only the original agent applies fixes.
- **The held turn.** A message with `@council` does not start its turn at once. The thread stays `queued` while the council meets, and the moderator's turn then opens with the council's brief added to its message, not to the fixed prefix.
- **Limits.** A reviewer has 15 minutes and a council 30. Spend caps are `PEER_REVIEW_MAX_COST_USD` (default 2.00) and `COUNCIL_MAX_COST_USD` (default 5.00). A run that exceeds either is cancelled (`by: "budget"` / `"timeout"`).
- **Stopping.** The card's Stop sends `thread.deliberation_cancel`. Stopping the parent turn stops every child, and a stopped council drops its held turn. On a restart, running deliberations are closed as `cancelled { by: "restart" }`, and a held council turn is released with the other queued threads.
