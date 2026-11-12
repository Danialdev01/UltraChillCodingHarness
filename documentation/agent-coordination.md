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
