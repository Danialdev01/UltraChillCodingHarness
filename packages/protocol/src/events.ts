import { z } from "zod";
import { ProjectDatabase } from "./database.js";
import { BranchName, PreviewHash, ProjectHash, ThreadHash } from "./ids.js";

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

/**
 * What a project is for. Stored and shown; nothing behaves differently by it
 * yet, except that only a development project may ask for a database.
 */
export const ProjectMode = z.enum(["research", "development", "creative_design"]);
export type ProjectMode = z.infer<typeof ProjectMode>;

export const PROJECT_MODE_LABELS: Record<ProjectMode, string> = {
  research: "Research",
  development: "Development",
  creative_design: "Creative design",
};

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
  /** Absent on events written before modes existed, which read as development. */
  mode: ProjectMode.optional(),
  /** The development database the clone reactor creates for it, if any. */
  database: ProjectDatabase.nullable().optional(),
});

const ProjectCloned = z.object({
  type: z.literal("project.cloned"),
  projectId: z.string().uuid(),
  headSha: z.string(),
  stack: z.string(),
  /**
   * Set when the project asked for a database and creating it failed. The
   * project itself is fine; the database is what is missing.
   */
  databaseError: z.string().optional(),
});

/**
 * The stack looked at again after the clone, and found to have changed: a
 * project that grew a framework, or moved to another language. Checked every
 * few turns by the agent service; only a change is recorded.
 */
const ProjectStackDetected = z.object({
  type: z.literal("project.stack_detected"),
  projectId: z.string().uuid(),
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
  /** Absent on threads created before workspaces had members. */
  createdByUserId: z.string().uuid().optional(),
  credentialSource: z.enum(["member", "workspace"]).optional(),
  /** The session's web address. Absent on threads created before it had one. */
  hash: ThreadHash.optional(),
  /**
   * Set together for a project session that works in its own worktree:
   * `branch` is created from `baseBranch` by `WorktreeReactor`.
   */
  baseBranch: BranchName.optional(),
  branch: z.string().optional(),
});

/** The session's worktree exists and is checked out on its branch. */
const ThreadWorktreeReady = z.object({
  type: z.literal("thread.worktree_ready"),
  threadId: z.string().uuid(),
});

/** `git worktree add` refused; the session cannot run until it is recreated. */
const ThreadWorktreeFailed = z.object({
  type: z.literal("thread.worktree_failed"),
  threadId: z.string().uuid(),
  error: z.string(),
});

/**
 * A project session is gone: settled, or removed for having nothing in it.
 * Its thread, worktree and local branch are deleted; `pushedBranch` names
 * the branch its work was pushed to first, when it had any. Project-scoped,
 * since the thread it names no longer exists to carry it.
 */
const ThreadRemoved = z.object({
  type: z.literal("thread.removed"),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  hash: ThreadHash.optional(),
  pushedBranch: z.string().nullable(),
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
 * An enum rather than a boolean per mode, so the modes cannot both be on:
 * `research` runs the research pipeline, `documentation` the document
 * pipeline -- read, edit, render and check PDF, DOCX and DOC files.
 */
export const MessageMode = z.enum(["research", "documentation"]);
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
   * `documentation` is the document pipeline's rules, prepended to a CLI
   * provider's prompt for the same reason.
   */
  source: z.enum([
    "system_prompt",
    "project_context",
    "agents_md",
    "file_tree",
    "compaction",
    "research",
    "documentation",
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

/**
 * A CLI provider has paused a tool call and is waiting for a person.
 *
 * The CLI's permission mode covers edits in the workspace; anything past
 * that -- a shell command, a fetch -- comes here instead of being denied
 * behind the reader's back. Durable: a page reloaded mid-prompt must still
 * show the question, or the turn just looks hung. `agent.permission_resolved`
 * closes it; a turn that ends first closes it as denied.
 */
const AgentPermissionRequested = z.object({
  type: z.literal("agent.permission_requested"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  requestId: z.string().min(1),
  /** The call it gates, when the CLI names it; the row in the chat. */
  toolUseId: z.string().nullable(),
  toolName: z.string(),
  input: z.unknown(),
  /** The CLI's one-line gloss of the call, when it offers one. */
  description: z.string().nullable(),
});

const AgentPermissionResolved = z.object({
  type: z.literal("agent.permission_resolved"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  requestId: z.string().min(1),
  behavior: z.enum(["allow", "deny"]),
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

/**
 * Stop reasons that mean a completed turn ran out of room rather than
 * finished: the native loop's iteration cap, a model's output cap under
 * either vendor's name. The Claude CLI reports its own, `error_max_turns`
 * and the like, as `error_*` -- see `stoppedShort`.
 */
export const LIMIT_STOP_REASONS: ReadonlySet<string> = new Set(["max_iterations", "max_tokens", "length"]);

/** Whether a turn that completed with this stop reason was cut off by a limit or an error. */
export function stoppedShort(stopReason: string | null | undefined): boolean {
  if (!stopReason) return false;
  return LIMIT_STOP_REASONS.has(stopReason) || stopReason.startsWith("error");
}

const AgentTurnFailed = z.object({
  type: z.literal("agent.turn_failed"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
  error: z.string(),
});

// -- Checkpoints and files ---------------------------------------------------

/**
 * Who made a change, and from which browser tab.
 *
 * Carried on the live notices so the tab that made a change can recognise its
 * own echo by identity rather than by guessing from a timestamp, and so every
 * other view can say who it was -- the same person in another window today,
 * a collaborator once projects are shared.
 */
export const ChangeOrigin = z.object({
  userId: z.string().uuid(),
  clientId: z.string().min(1).max(64),
});
export type ChangeOrigin = z.infer<typeof ChangeOrigin>;

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
  /** Absent when the agent wrote it rather than a person. */
  origin: ChangeOrigin.optional(),
});

/**
 * A project note was written. Notes are plain rows in Postgres, not
 * event-sourced -- like `file.changed`, this is a nudge to other open tabs to
 * refetch, not the change itself, so it is transient.
 */
const NoteChanged = z.object({
  type: z.literal("note.changed"),
  projectId: z.string().uuid(),
  noteId: z.string().uuid(),
  change: z.enum(["created", "updated", "moved", "deleted"]),
  /** Lets the tab that made the change recognise its own write and skip the refetch. */
  updatedAt: z.string().datetime(),
  origin: ChangeOrigin.optional(),
  /**
   * What an update wrote, so open tabs can apply it without a round trip.
   * `content` is left out of a page too large to be worth pushing; a tab
   * that needs it and does not find it here refetches.
   */
  fields: z
    .object({
      title: z.string().optional(),
      icon: z.string().nullable().optional(),
      cover: z.string().nullable().optional(),
      content: z.unknown().optional(),
      /** The body changed but was too large to push: refetch it. */
      contentOmitted: z.boolean().optional(),
    })
    .optional(),
  /** Where a deleted page's readers should go instead. */
  parentId: z.string().uuid().nullable().optional(),
});

/**
 * A task on the project's timeline was written. The same shape and the same
 * reason as `note.changed`: a nudge to the project's other open tabs.
 */
const TimelineChanged = z.object({
  type: z.literal("timeline.changed"),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  change: z.enum(["created", "updated", "deleted"]),
  /** Lets the tab that made the change recognise its own write and skip the refetch. */
  updatedAt: z.string().datetime(),
  origin: ChangeOrigin.optional(),
});

/**
 * A card on the project's Tasks board was written -- by a person, or by the
 * pipeline moving it along. A nudge to refetch, like `timeline.changed`.
 */
const TaskChanged = z.object({
  type: z.literal("task.changed"),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  change: z.enum(["created", "updated", "deleted"]),
  updatedAt: z.string().datetime(),
  origin: ChangeOrigin.optional(),
});

// -- Live collaboration ------------------------------------------------------

/**
 * What is typed in a thread's prompt box, shared by every tab looking at it.
 *
 * Only what can be re-shown elsewhere: an attachment travels once it is
 * staged on the server, since a file still uploading exists only in the tab
 * that picked it.
 */
export const ComposerDraft = z.object({
  text: z.string().max(200_000),
  attachments: z
    .array(
      z.object({
        id: z.string().max(400),
        name: z.string().max(400),
        size: z.number().int().nonnegative(),
        type: z.string().max(200),
        text: z.string().nullable(),
        uploadId: z.string().nullable(),
        status: z.enum(["uploading", "staged", "failed"]),
        error: z.string().optional(),
      }),
    )
    .max(50),
  reference: z
    .object({ path: z.string(), from: z.number().int(), to: z.number().int() })
    .nullable(),
  model: z.string().max(200).optional(),
  effort: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Legacy: drafts saved before `mode` existed. Read as `mode: "research"`. */
  research: z.boolean().optional(),
  mode: MessageMode.optional(),
  provider: z.string().max(40).optional(),
});
export type ComposerDraft = z.infer<typeof ComposerDraft>;

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", attachments: [], reference: null };

/**
 * The prompt box of a thread changed. `rev` only goes up; a tab sends the rev
 * it last saw, and an update made against an older one is refused -- someone
 * else typed in between.
 */
const ComposerChanged = z.object({
  type: z.literal("composer.changed"),
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  rev: z.number().int().nonnegative(),
  draft: ComposerDraft,
  /** Null when the server cleared it, on a send. */
  origin: ChangeOrigin.nullable(),
});

/** Where a tab is looking: `note:<id>`, `thread:<id>`, `file:<path>`, or a page name. */
export const PresenceViewer = z.object({
  userId: z.string().uuid(),
  clientId: z.string(),
  location: z.string().max(600),
  /** Changing something there right now. */
  editing: z.boolean(),
});
export type PresenceViewer = z.infer<typeof PresenceViewer>;

/** Everyone with the project open, sent whole whenever any of it changes. */
const PresenceChanged = z.object({
  type: z.literal("presence.changed"),
  projectId: z.string().uuid(),
  viewers: z.array(PresenceViewer),
});

export const LiveResource = z.enum([
  "keys",
  "database_connections",
  "project_settings",
  "account_settings",
  "projects",
  /** The project's git state: the index, branches, the remote. */
  "git",
  /** Rows or structure of a table in a database manager connection; `id` is `conn/db/table`. */
  "database_data",
  /** A workspace's members, invite links or harness subscription; `id` is the workspace. */
  "workspace_members",
  /** A diagram's generation started or ended; `id` is the diagram kind. */
  "diagrams",
]);
export type LiveResource = z.infer<typeof LiveResource>;

/**
 * Something without a richer notice of its own changed: a nudge to refetch.
 * `projectId` is null for what belongs to the account rather than a project,
 * which is published to the user's own topic instead.
 */
const ResourceChanged = z.object({
  type: z.literal("resource.changed"),
  projectId: z.string().uuid().nullable(),
  resource: LiveResource,
  id: z.string().optional(),
  origin: ChangeOrigin.optional(),
});

/** One line of the project's activity log. */
export const AuditEntry = z.object({
  id: z.string(),
  projectId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  /** The login or email to show, resolved when the entry is read. */
  actor: z.string().nullable(),
  clientId: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  details: z.record(z.unknown()),
  /** How many edits this line stands for: repeated saves of one thing coalesce. */
  count: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

const AuditRecorded = z.object({
  type: z.literal("audit.recorded"),
  /** Null for a change to the account, published to the user's own topic. */
  projectId: z.string().uuid().nullable(),
  entry: AuditEntry,
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
  ProjectStackDetected,
  ContainerStateChanged,
  ThreadCreated,
  ThreadWorktreeReady,
  ThreadWorktreeFailed,
  ThreadRemoved,
  UserMessage,
  ThreadCancelRequested,
  ContextInjected,
  TurnStarted,
  AgentSessionStarted,
  AgentRetry,
  AgentThinkingDelta,
  AgentTextDelta,
  AgentToolUse,
  AgentPermissionRequested,
  AgentPermissionResolved,
  AgentToolResult,
  AgentMessage,
  AgentTurnCompleted,
  AgentTurnFailed,
  CheckpointCaptured,
  CheckpointReverted,
  FileChanged,
  NoteChanged,
  TimelineChanged,
  TaskChanged,
  ComposerChanged,
  PresenceChanged,
  ResourceChanged,
  AuditRecorded,
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
  "note.changed",
  "timeline.changed",
  "task.changed",
  "composer.changed",
  "presence.changed",
  "resource.changed",
  "audit.recorded",
]);

export function isTransient(type: DomainEventType): boolean {
  return TRANSIENT.has(type);
}
