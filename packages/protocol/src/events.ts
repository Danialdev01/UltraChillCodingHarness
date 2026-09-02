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
  repoUrl: z.string().url(),
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

const UserMessage = z.object({
  type: z.literal("user.message"),
  threadId: z.string().uuid(),
  text: z.string(),
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
  source: z.enum(["system_prompt", "project_context", "agents_md", "file_tree", "compaction"]),
  content: z.string(),
  tokens: z.number().int().nonnegative().optional(),
});

// -- Agent turn --------------------------------------------------------------

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
  ContextInjected,
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
]);

export function isTransient(type: DomainEventType): boolean {
  return TRANSIENT.has(type);
}
