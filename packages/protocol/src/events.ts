import { z } from "zod";
import { PreviewHash, ProjectHash } from "./ids.js";

/**
 * The append-only session log.
 *
 * Scope: this log records *project activity* -- containers, agent turns,
 * files, ports, git, previews. Identity and organisation (users, sessions,
 * workspaces) are plain state and are not event-sourced, which is why every
 * event here carries a project. That boundary is deliberate: replaying the
 * log rebuilds what happened inside projects, not who exists.
 *
 * Every event the agent loop, the container runtime, and the user produce is
 * appended here in order. Every other table in the database is a projection
 * that can be rebuilt by replaying this stream, which is what makes threads
 * resumable, forkable, and replayable.
 *
 * Events are immutable. To correct state, append a new event -- never rewrite
 * a past one.
 */

// -- Project and container lifecycle ----------------------------------------

export const ContainerState = z.enum(["absent", "creating", "running", "stopped", "error"]);
export type ContainerState = z.infer<typeof ContainerState>;

const ProjectCreated = z.object({
  type: z.literal("project.created"),
  projectId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  hash: ProjectHash,
  name: z.string(),
  /**
   * Null for a project started empty, which has no remote to clone and
   * nothing to push to until somebody adds one.
   *
   * Nullable rather than optional so the absence is recorded rather than
   * merely missing, and so every event written since this existed says which
   * kind of project it opened.
   */
  repoUrl: z.string().url().nullable(),
  defaultBranch: z.string(),
});

const ProjectCloned = z.object({
  type: z.literal("project.cloned"),
  projectId: z.string().uuid(),
  headSha: z.string(),
  stack: z.string(),
});

const ContainerStateChanged = z.object({
  type: z.literal("container.state_changed"),
  projectId: z.string().uuid(),
  state: ContainerState,
  error: z.string().optional(),
});

// -- Threads and user input --------------------------------------------------

const ThreadCreated = z.object({
  type: z.literal("thread.created"),
  threadId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
});

/**
 * One image a message showed the model.
 *
 * Carries the name and type beside the id so the record is self-describing.
 * Replay must not depend on a staging lookup: the bytes are swept on a TTL,
 * and a thread read back a week later still has to say what was attached
 * even when it can no longer show it.
 */
export const MessageImage = z.object({
  uploadId: z.string().min(1).max(200),
  name: z.string().max(400),
  type: z.string().max(200),
});
export type MessageImage = z.infer<typeof MessageImage>;

/**
 * The one way a message can ask for something other than a coding turn.
 *
 * An enum with a single member rather than a boolean, so a second mode is a
 * new member rather than a second flag that has to agree with the first.
 */
export const MessageMode = z.enum(["research"]);
export type MessageMode = z.infer<typeof MessageMode>;

const UserMessage = z.object({
  type: z.literal("user.message"),
  threadId: z.string().uuid(),
  text: z.string(),
  /**
   * Attachments the model is shown as pictures rather than described to.
   *
   * Optional, and absent on every message that has none: an ordinary message
   * is not reshaped by a feature it did not use, and neither is a log full
   * of them.
   */
  images: z.array(MessageImage).max(8).optional(),
  /**
   * Recorded on the event, not only on the command: the reactor reads the
   * event to start the turn, and the chat shows a reader which of their
   * messages asked for research. Absent on an ordinary message.
   */
  mode: MessageMode.optional(),
});

/**
 * A cancellation was asked for. The turn is not over at this point: the
 * reactor aborts the run in flight, and the loop still closes it with an
 * `agent.turn_completed` carrying `stopReason: "cancelled"`.
 *
 * It is recorded rather than left implicit because `threads.status` is a
 * projection: without an event, the `cancelling` state could not be rebuilt
 * by replaying the log, and a reader would see a thread sitting in `running`
 * with nothing explaining why the stream had stopped.
 */
const ThreadCancelRequested = z.object({
  type: z.literal("thread.cancel_requested"),
  threadId: z.string().uuid(),
});

/**
 * Records anything injected into the model's context that the user did not
 * type -- the system prompt, the file tree, AGENTS.md, a compaction summary.
 * Logging these is what makes a run exactly reproducible rather than
 * approximately reproducible.
 */
const ContextInjected = z.object({
  type: z.literal("context.injected"),
  threadId: z.string().uuid(),
  /**
   * `research` is the brief a research phase produced for a CLI provider's
   * turn: gathered on OpenRouter, then appended to the prompt the CLI was
   * given. Recorded so the log says exactly what the CLI was handed.
   */
  source: z.enum([
    "system_prompt",
    "project_context",
    "agents_md",
    "file_tree",
    "compaction",
    "research",
  ]),
  content: z.string(),
  tokens: z.number().int().nonnegative().optional(),
});

// -- Agent turn --------------------------------------------------------------

/**
 * Which backend answers a turn.
 *
 * `native` is the harness's own loop against OpenRouter. `claude` and `codex`
 * are the vendors' CLIs, run as processes and billed to the person's own
 * subscription. Every provider normalises into the same events below: the
 * browser never needs to know which one produced a line, and must not.
 */
export const ProviderId = z.enum(["native", "claude", "codex"]);
export type ProviderId = z.infer<typeof ProviderId>;

/** The providers that keep a session of their own to resume. */
export const CliProviderId = z.enum(["claude", "codex"]);
export type CliProviderId = z.infer<typeof CliProviderId>;

/**
 * A turn has begun. The reactor mints the `turnId` and emits this before the
 * first model call, which makes it the anchor for the whole turn: the
 * projection inserts the `turns` row and moves the thread to `running`, and
 * every later event of the turn refers back to this id.
 *
 * The reactor owns it rather than `decide()` because a turn is a lifecycle,
 * not a decision -- minting an id inside the pure layer would make it
 * non-deterministic. It is deliberately durable: the `turns` row, the
 * one-turn-at-a-time guard and cancellation all depend on it surviving a
 * restart.
 */
const TurnStarted = z.object({
  type: z.literal("turn.started"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  /**
   * The model the turn will be billed against, resolved from the command's
   * choice or the harness default. Optional so events appended before the
   * field existed still parse; the usage breakdown counts those as unknown.
   */
  model: z.string().optional(),
  /**
   * The backend the turn runs under. Optional for the same reason as
   * `model`: earlier events predate it, and absent reads as `native`.
   */
  provider: ProviderId.optional(),
});

/**
 * A CLI provider has opened or resumed its own session for this thread.
 *
 * The `sessionId` is the provider's resume token -- what `--resume` (Claude)
 * or `exec resume` (Codex) is given next turn. Durable, and recorded the
 * moment the CLI reports it rather than at the end of the turn: a turn that
 * is killed part-way still has a session to pick up, which is how the CLI
 * itself recovers an unfinished turn.
 */
const AgentSessionStarted = z.object({
  type: z.literal("agent.session_started"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  provider: CliProviderId,
  sessionId: z.string().min(1),
});

/**
 * The provider is waiting out a transient API error. Transient here too: it
 * is a progress note for whoever is watching, not a fact about the thread.
 */
const AgentRetry = z.object({
  type: z.literal("agent.retry"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  attempt: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  delayMs: z.number().int().nonnegative(),
  category: z.string(),
});

const AgentThinkingDelta = z.object({
  type: z.literal("agent.thinking_delta"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  text: z.string(),
});

const AgentTextDelta = z.object({
  type: z.literal("agent.text_delta"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  text: z.string(),
});

const AgentToolUse = z.object({
  type: z.literal("agent.tool_use"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const AgentToolResult = z.object({
  type: z.literal("agent.tool_result"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * The complete assistant content blocks for one API response, stored verbatim.
 *
 * Deltas are not sufficient to rebuild this: thinking blocks carry signatures
 * that must be echoed back to the API unchanged when the thread continues on
 * the same model. Reconstructing them from text deltas would drop the
 * signature and invalidate the turn. This event is what makes a thread
 * genuinely resumable.
 */
const AgentMessage = z.object({
  type: z.literal("agent.message"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  /** Raw `Message.content` from the Anthropic SDK, passed through untouched. */
  content: z.array(z.unknown()),
});

const AgentTurnCompleted = z.object({
  type: z.literal("agent.turn_completed"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  stopReason: z.string().nullable(),
  usage: TokenUsage,
  costUsd: z.number().nonnegative(),
});

const AgentTurnFailed = z.object({
  type: z.literal("agent.turn_failed"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  error: z.string(),
});

// -- Checkpoints and files ---------------------------------------------------

const CheckpointCaptured = z.object({
  type: z.literal("checkpoint.captured"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  position: z.enum(["before", "after"]),
  ref: z.string(),
  commitSha: z.string(),
});

const CheckpointReverted = z.object({
  type: z.literal("checkpoint.reverted"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  commitSha: z.string(),
});

const FileChanged = z.object({
  type: z.literal("file.changed"),
  projectId: z.string().uuid(),
  path: z.string(),
  change: z.enum(["added", "modified", "deleted"]),
});

// -- Runtime -----------------------------------------------------------------

const PortOpened = z.object({
  type: z.literal("port.opened"),
  projectId: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  /**
   * False when the process bound 127.0.0.1 only. Such a listener is
   * unreachable from the gateway container, so the UI surfaces a rebind hint
   * rather than a dead link.
   */
  reachable: z.boolean(),
});

const PortClosed = z.object({
  type: z.literal("port.closed"),
  projectId: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
});

const TerminalOutput = z.object({
  type: z.literal("terminal.output"),
  projectId: z.string().uuid(),
  terminalId: z.string(),
  data: z.string(),
});

// -- Git and previews --------------------------------------------------------

const GitCommitted = z.object({
  type: z.literal("git.committed"),
  projectId: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  commitSha: z.string(),
  branch: z.string(),
  message: z.string(),
});

const GitPushed = z.object({
  type: z.literal("git.pushed"),
  projectId: z.string().uuid(),
  branch: z.string(),
  remoteSha: z.string(),
});

const PreviewPublished = z.object({
  type: z.literal("preview.published"),
  projectId: z.string().uuid(),
  hash: PreviewHash,
  commitSha: z.string(),
  port: z.number().int().min(1).max(65535),
  expiresAt: z.string().datetime(),
});

// -- Union -------------------------------------------------------------------

export const DomainEvent = z.discriminatedUnion("type", [
  ProjectCreated,
  ProjectCloned,
  ContainerStateChanged,
  ThreadCreated,
  UserMessage,
  ThreadCancelRequested,
  ContextInjected,
  TurnStarted,
  AgentSessionStarted,
  AgentRetry,
  AgentThinkingDelta,
  AgentTextDelta,
  AgentToolUse,
  AgentToolResult,
  AgentMessage,
  AgentTurnCompleted,
  AgentTurnFailed,
  CheckpointCaptured,
  CheckpointReverted,
  FileChanged,
  PortOpened,
  PortClosed,
  TerminalOutput,
  GitCommitted,
  GitPushed,
  PreviewPublished,
]);

export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent["type"];

/** A persisted event: the domain payload plus its position in the log. */
export const StoredEvent = z.object({
  id: z.string(),
  threadId: z.string().uuid().nullable(),
  projectId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  event: DomainEvent,
});
export type StoredEvent = z.infer<typeof StoredEvent>;

/**
 * High-frequency events are streamed to clients but not worth a database row
 * each -- terminal bytes and token deltas would dominate the log and are
 * reconstructible from the completed turn. They are published to subscribers
 * and dropped from the durable stream.
 */
const TRANSIENT: ReadonlySet<DomainEventType> = new Set([
  "terminal.output",
  "agent.thinking_delta",
  "agent.text_delta",
  "agent.retry",
]);

export function isTransient(type: DomainEventType): boolean {
  return TRANSIENT.has(type);
}
