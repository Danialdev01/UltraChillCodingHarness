import { z } from "zod";
import { ProjectDatabase } from "./database.js";
import { MessageImage, MessageMode, PlanStage, ProjectMode, ProviderId, ReviewerDirectiveSchema, ReviewScope } from "./events.js";
import { PEER_REVIEW_MAX_REVIEWERS } from "./plain.js";
import { BranchName, PreviewHash, ThreadHash } from "./ids.js";
import { MessageKnowledge } from "./knowledge.js";

/**
 * Commands are the only way a client changes anything.
 *
 * A command is a request, not a fact. The server's `decide()` function
 * validates it against current state and emits the events that record what
 * actually happened -- which may be nothing, or an error event. Clients never
 * write to the read model directly.
 */

const ProjectCreate = z.object({
  type: z.literal("project.create"),
  /** The workspace to create it in. Must be owned by the caller. */
  workspaceId: z.string().uuid(),
  /**
   * The repository to clone, or absent to start an empty one.
   *
   * Absent is not "unknown": it is the project that has no remote yet, and
   * the clone reactor reads it as an instruction to run `git init` instead of
   * `git clone`. A project like that needs a `name`, because there is no URL
   * to derive one from -- `decide()` refuses the command that has neither.
   */
  repoUrl: z.string().url().optional(),
  name: z.string().min(1).max(100).optional(),
  branch: z.string().optional(),
  /** Development when absent. */
  mode: ProjectMode.optional(),
  /** A database to create on the shared dev server. Development projects only. */
  database: ProjectDatabase.optional(),
  /**
   * Whether each session gets a branch (`ucch/{hash}`) and worktree of its
   * own. False: sessions work in the project's checkout and commit straight
   * to the base branch. True when absent.
   */
  sessionBranches: z.boolean().optional(),
  /** The connected git account the repository was picked from; git uses it first. */
  gitAccountId: z.string().uuid().optional(),
});

const ProjectStart = z.object({
  type: z.literal("project.start"),
  projectId: z.string().uuid(),
});

const ProjectStop = z.object({
  type: z.literal("project.stop"),
  projectId: z.string().uuid(),
});

const ProjectDelete = z.object({
  type: z.literal("project.delete"),
  projectId: z.string().uuid(),
});

const ThreadCreate = z.object({
  type: z.literal("thread.create"),
  projectId: z.string().uuid(),
  title: z.string().max(200).optional(),
  /**
   * Whose subscription the thread runs on, when the workspace lets the
   * starter choose (`either`). Ignored under a fixed policy.
   */
  credentialSource: z.enum(["member", "workspace"]).optional(),
  /**
   * Makes this a parallel project session: it gets its own git worktree on
   * a new branch forked from this one. Absent, the thread shares the
   * project's main folder.
   */
  baseBranch: BranchName.optional(),
  /**
   * Works in this thread's folder instead of one of its own: its worktree
   * and branch when it has them, the project's checkout when it does not.
   * What a handoff's new thread is made with (solution §5.4), so the work
   * carries on where it is. Excludes `baseBranch`.
   */
  worktreeOf: z.string().uuid().optional(),
  /**
   * A subagent's session: a hidden child of this thread, started by the
   * server when the parent's agent calls `ucch_agent`. It works in the
   * parent's folder (as `worktreeOf`) and is left out of the sessions list.
   * Only the server may set it; a client's command naming it is refused.
   */
  parentThreadId: z.string().uuid().optional(),
  /**
   * The subscription account (`agent_profiles`) the session's Claude Code
   * or Codex turns sign in as. Must be the subject's own -- the starter's,
   * or the workspace's when it runs on the workspace's subscription -- and
   * fit the project's required context. Absent: the project's default for
   * the person, else the Default account.
   */
  profileId: z.string().uuid().optional(),
  /** Server-only, with `parentThreadId`: a session no turn of which may change anything. */
  readOnly: z.literal(true).optional(),
});

/**
 * How hard a reasoning model should think before answering. Models that do
 * not reason ignore it, so it is safe to send either way.
 *
 * `xhigh` and `max` are Claude Code's levels above `high`; OpenRouter stops
 * at `high`, and the native loop clamps to it. Under a CLI, `off` means "no
 * flag": the CLI's own default for the model, not reasoning switched off.
 */
export const ReasoningEffort = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** Queues an agent turn. The turn itself runs in `AgentTurnReactor`. */
const AgentMessageSend = z.object({
  type: z.literal("thread.agent_message"),
  threadId: z.string().uuid(),
  fromThreadId: z.string().uuid(),
  text: z.string().trim().min(1).max(60_000),
  replyTo: z.string().uuid().optional(),
  depth: z.number().int().min(0).max(100).default(0),
});

const ThreadSend = z.object({
  type: z.literal("thread.send"),
  /** Follow-up for an existing native worker in this thread. */
  subagentId: z.string().min(1).max(500).optional(),
  agentMessageIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  /** Server-only: the review whose findings this message sends back to be fixed. */
  peerReviewId: z.string().uuid().optional(),
  /** Server-only, with `peerReviewId`: review the fix. A person asks with `@reviewer` in `text`. */
  reviewer: ReviewerDirectiveSchema.optional(),
  threadId: z.string().uuid(),
  text: z.string().min(1),
  /** An OpenRouter model id. Falls back to the harness default when absent. */
  model: z.string().min(1).max(200).optional(),
  effort: ReasoningEffort.optional(),
  /**
   * Which backend answers. Absent falls back to the thread's own provider,
   * then the account's default, then `native`. A thread that has already run
   * under one provider refuses another: the CLI session it resumes belongs
   * to that provider alone.
   */
  provider: ProviderId.optional(),
  /**
   * Attachments this message wants the model to actually look at.
   *
   * A subset of the message's attachments, not a second list of them: the
   * text manifest still describes every file, and this names the ones that
   * are pictures. They stay staged either way -- being shown to the model
   * and being placed in the workspace are separate decisions, and a
   * screenshot is usually only ever the first.
   */
  images: z.array(MessageImage).max(8).optional(),
  /**
   * How the turn should work. Absent is an ordinary coding turn; `research`
   * runs the research pipeline instead -- Perplexity Sonar to find, Crawl4AI
   * to read, a browser agent for what the crawler cannot reach. On the
   * native loop that is the turn itself; on a CLI provider the pipeline runs
   * first, on OpenRouter, and its brief is handed to the CLI with the
   * message. `documentation` runs the document pipeline: typed tools that
   * read, edit, render and check PDF/DOCX/DOC files on the native loop, or
   * the same rules and scripts prepended for a CLI provider. Allowed on any
   * thread, bound or not.
   */
  mode: MessageMode.optional(),
  /**
   * Plan mode (`/plan`): `draft` is a read-only turn that asks what it needs
   * and ends with a plan to approve; `run` carries out the thread's newest
   * proposed plan. Wins over `mode`: a plan turn is an ordinary coding turn.
   */
  plan: PlanStage.optional(),
  /**
   * The workspace's knowledge bases this message is answered from, and
   * whether the agent may also search the web. Absent is an ordinary turn.
   * Bases outside the thread's workspace are dropped by the server, not
   * trusted from here.
   */
  knowledge: MessageKnowledge.optional(),
});

/**
 * Renames, pins or archives a session. Only the fields given change; at
 * least one must be. A title is trimmed, and an empty one refused.
 */
const ThreadUpdate = z.object({
  type: z.literal("thread.update"),
  threadId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

/** Interrupts a running turn between tool calls. */
const ThreadCancel = z.object({
  type: z.literal("thread.cancel"),
  threadId: z.string().uuid(),
});

/**
 * Answers a CLI provider's permission prompt.
 *
 * The CLI paused a tool call that its permission mode does not cover -- a
 * shell command, typically -- and asked. `allow` runs it as asked; `deny`
 * hands the model `message` as the tool's error, so it can try something
 * else or explain what it needed. A request that has already been answered,
 * or whose turn has ended, is a no-op: the reactor drops it.
 *
 * `scope: "session"` with `allow` is the prompt's "Allow All": this prompt
 * and every later one on the thread are allowed until the server restarts.
 */
const ThreadPermissionReply = z.object({
  type: z.literal("thread.permission_reply"),
  threadId: z.string().uuid(),
  requestId: z.string().min(1),
  behavior: z.enum(["allow", "deny"]),
  message: z.string().max(2_000).optional(),
  scope: z.enum(["once", "session"]).optional(),
});

/**
 * Reverts files *and* thread state to the checkpoint taken before `turnId`.
 * Rolling back only one of the two is the inconsistency this command exists
 * to prevent.
 */
const ThreadRevert = z.object({
  type: z.literal("thread.revert"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
});

const ThreadFork = z.object({
  type: z.literal("thread.fork"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid(),
});

/**
 * Folds an idle OMP thread's older turns into a summary now, rather than
 * waiting for its context to fill (solution §5.3). `focus` is what the
 * summary should keep, handed to OMP as its `customInstructions`.
 */
const ThreadCompact = z.object({
  type: z.literal("thread.compact"),
  threadId: z.string().uuid(),
  focus: z.string().trim().max(2_000).optional(),
  /** Server-only: the session sat idle with its prompt cache about to run out (plan2 §3.3). */
  idle: z.boolean().optional(),
});

/**
 * A handover on an idle thread that has run: the session's context is
 * replaced by a brief of the work so far -- what was done, what matters,
 * what is next -- and the thread carries on from that, on the same
 * harness. On OMP it is OMP's own handoff (solution §5.3); on any other
 * harness the server writes the brief and opens a fresh session with it
 * (a `thread.harness_switch_requested` to the same provider, reason
 * `context`). It replaces clearing: the work is kept, the bloat is not.
 */
const ThreadHandoff = z.object({
  type: z.literal("thread.handoff"),
  threadId: z.string().uuid(),
  focus: z.string().trim().max(2_000).optional(),
  /**
   * The server handed over by itself: the session ended a turn past the
   * fallback line (`CONTEXT_FORCE_RATIO`). On every CLI that is a
   * compaction in the same session, not a handover (plan2 §3.2); quiet, and
   * it sends nothing.
   */
  auto: z.boolean().optional(),
  /**
   * Server-only, with `auto`: the session's own compaction could not run or
   * failed, so it is handed over to a fresh session after all.
   */
  fallback: z.boolean().optional(),
});

/**
 * Carries an idle thread's work on in a new thread on `targetProvider`
 * (solution §5.4): a brief of it, written from the thread's log, becomes
 * the new thread's first message, in the same folder. Any provider to any
 * provider -- a CLI session cannot move between them, but a brief can.
 */
const ThreadHandoffTo = z.object({
  type: z.literal("thread.handoff_to"),
  threadId: z.string().uuid(),
  targetProvider: ProviderId,
  focus: z.string().trim().max(2_000).optional(),
  /**
   * What the new thread is asked after the brief, in place of "Continue
   * from here.": the message a limit stopped, when the server hands off
   * on its own (`reason: "limit"`).
   */
  message: z.string().min(1).optional(),
  reason: z.literal("limit").optional(),
});

/**
 * Moves an idle thread onto another harness without leaving it: a brief of
 * the work so far is written from its log, the thread's provider becomes
 * `targetProvider`, and its next turn starts a fresh session there with the
 * brief ahead of the message. The same session, one transcript -- unlike
 * `thread.handoff_to`, which carries the work on in a new thread.
 *
 * `message`: sent as soon as the switch is made, on `model` -- the message a
 * usage limit stopped, when the switch answers one (`reason: "limit"`).
 */
const ThreadSwitchHarness = z.object({
  type: z.literal("thread.switch_harness"),
  threadId: z.string().uuid(),
  targetProvider: ProviderId,
  model: z.string().min(1).max(200).optional(),
  effort: ReasoningEffort.optional(),
  focus: z.string().trim().max(2_000).optional(),
  message: z.string().min(1).optional(),
  reason: z.enum(["limit", "manual"]).optional(),
  /**
   * The subscription account to carry on as. With the thread's own
   * provider as `targetProvider`, this is a move to another account of the
   * same provider -- allowed only as a person's choice, never `auto`.
   */
  targetProfileId: z.string().uuid().optional(),
  /**
   * The server switched by itself (a usage limit with automatic fallback),
   * not because someone picked this. An automatic switch never moves
   * between two accounts of one provider.
   */
  auto: z.boolean().optional(),
});

/**
 * The person's answer to an `agent.choice_requested` card: one of its
 * options by id, or `dismiss`. `model` is the model picked for an option
 * that takes one (`pickModel`); `at` the time for one that waits (`schedule`).
 */
const ThreadChoiceReply = z.object({
  type: z.literal("thread.choice_reply"),
  threadId: z.string().uuid(),
  requestId: z.string().min(1).max(100),
  optionId: z.string().min(1).max(100),
  model: z.string().min(1).max(200).optional(),
  at: z.string().datetime().optional(),
});

/** Moves a thread's scheduled resume to another time (now, when `at` is past), or with null cancels it. */
const ThreadResumeUpdate = z.object({
  type: z.literal("thread.resume_update"),
  threadId: z.string().uuid(),
  resumeId: z.string().uuid(),
  at: z.string().datetime().nullable(),
});

/** Reviews an answer (the latest, without `turnId`) with another agent: the card's "Review again". */
const ThreadPeerReview = z.object({
  type: z.literal("thread.peer_review"),
  threadId: z.string().uuid(),
  turnId: z.string().uuid().optional(),
  models: z.array(z.string().trim().min(1).max(100)).max(PEER_REVIEW_MAX_REVIEWERS).optional(),
  fix: z.boolean().optional(),
});

/** Sends a review's findings -- all of them, or the ones named -- to the thread's agent to fix. */
const ThreadPeerReviewFix = z.object({
  type: z.literal("thread.peer_review_fix"),
  threadId: z.string().uuid(),
  peerReviewId: z.string().uuid(),
  findingIds: z.array(z.string().max(100)).min(1).max(100).optional(),
});

/** Stops a running review or council, and everyone in it. */
const ThreadDeliberationCancel = z.object({
  type: z.literal("thread.deliberation_cancel"),
  threadId: z.string().uuid(),
  deliberationId: z.string().uuid(),
});

const TerminalCreate = z.object({
  type: z.literal("terminal.create"),
  projectId: z.string().uuid(),
  /**
   * Minted by the client, not the server.
   *
   * A terminal's output is a transient event, so `terminal.create` returns no
   * events to learn an id from -- and the client has to be subscribed to
   * `terminal:{id}` *before* the shell starts, or the first prompt is gone
   * before anyone is listening.
   */
  terminalId: z.string().uuid(),
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
  /**
   * What runs in it. Absent or `shell` is the login shell in the workspace. The login
   * programs run the vendor CLI's own sign-in flow against the caller's
   * credential directory -- the code-paste path, which is the documented one
   * for a machine whose browser is somewhere else. A fixed list, never a
   * command string: the client picks a program, the server knows the argv.
   */
  program: z.enum(["shell", "claude-login", "codex-login", "command"]).optional(),
  /**
   * `command` only: which of the project's command buttons to run, by its id
   * in `.agent/commands.json`. The server reads the command line from that
   * file, so this is still a choice from a list, not a string to execute.
   */
  commandId: z.string().min(1).max(40).optional(),
  /**
   * A login program only: sign in the workspace's dedicated subscription
   * rather than the caller's own. Must be the project's workspace, and the
   * caller must be allowed to manage its credentials.
   */
  credentialWorkspaceId: z.string().uuid().optional(),
  /**
   * A login program only: which of the subject's subscription accounts
   * (`agent_profiles`) to sign in. Absent: its Default account. The server
   * checks it is the subject's own before anything starts.
   */
  profileId: z.string().uuid().optional(),
  /** A project session's hash: the shell opens in that session's worktree. */
  sessionHash: ThreadHash.optional(),
  /**
   * The tab's name, as every page that lists the project's terminals shows
   * it: "Terminal 3", a command button's label. Display only.
   */
  label: z.string().min(1).max(60).optional(),
});

const TerminalInput = z.object({
  type: z.literal("terminal.input"),
  terminalId: z.string(),
  data: z.string(),
});

const TerminalResize = z.object({
  type: z.literal("terminal.resize"),
  terminalId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const TerminalClose = z.object({
  type: z.literal("terminal.close"),
  terminalId: z.string(),
});

const FileWrite = z.object({
  type: z.literal("file.write"),
  projectId: z.string().uuid(),
  path: z.string(),
  content: z.string(),
});

const GitCommit = z.object({
  type: z.literal("git.commit"),
  projectId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  message: z.string().min(1),
});

/**
 * Pushing is outward-facing and hard to reverse, so it is a user command with
 * no corresponding agent tool. The agent can commit; only a person can push.
 */
const GitPush = z.object({
  type: z.literal("git.push"),
  projectId: z.string().uuid(),
  branch: z.string(),
});

const PreviewPublish = z.object({
  type: z.literal("preview.publish"),
  projectId: z.string().uuid(),
  commitSha: z.string().optional(),
  ttlDays: z.number().int().min(1).max(30).default(7),
});

const PreviewDelete = z.object({
  type: z.literal("preview.delete"),
  hash: PreviewHash,
});

/**
 * Reviews code with OMP's `reviewer` (solution §9): the uncommitted changes,
 * the branch since `ref` (the project's default branch when absent), or the
 * commit `ref` (HEAD when absent), in the session's worktree for `threadId`
 * and the project's checkout without one. Billed as an OMP run.
 */
const ReviewRun = z.object({
  type: z.literal("review.run"),
  projectId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  scope: ReviewScope,
  ref: z
    .string()
    .min(1)
    .max(256)
    .refine((ref) => !ref.startsWith("-"), "not a ref")
    .optional(),
  focus: z.string().max(2_000).optional(),
});

export const Command = z.discriminatedUnion("type", [
  ProjectCreate,
  ProjectStart,
  ProjectStop,
  ProjectDelete,
  ThreadCreate,
  ThreadSend,
  AgentMessageSend,
  ThreadUpdate,
  ThreadCancel,
  ThreadPermissionReply,
  ThreadRevert,
  ThreadFork,
  ThreadCompact,
  ThreadHandoff,
  ThreadHandoffTo,
  ThreadSwitchHarness,
  ThreadChoiceReply,
  ThreadResumeUpdate,
  ThreadPeerReview,
  ThreadPeerReviewFix,
  ThreadDeliberationCancel,
  TerminalCreate,
  TerminalInput,
  TerminalResize,
  TerminalClose,
  FileWrite,
  GitCommit,
  GitPush,
  PreviewPublish,
  PreviewDelete,
  ReviewRun,
]);

export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
