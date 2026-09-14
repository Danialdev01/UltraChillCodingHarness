import { z } from "zod";
import { MessageImage, MessageMode, ProviderId } from "./events.js";
import { PreviewHash } from "./ids.js";

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
});

/**
 * How hard a reasoning model should think before answering. Models that do
 * not reason ignore it, so it is safe to send either way.
 */
export const ReasoningEffort = z.enum(["off", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** Queues an agent turn. The turn itself runs in `AgentTurnReactor`. */
const ThreadSend = z.object({
  type: z.literal("thread.send"),
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
   * message. Allowed on any thread, bound or not.
   */
  mode: MessageMode.optional(),
});

/** Interrupts a running turn between tool calls. */
const ThreadCancel = z.object({
  type: z.literal("thread.cancel"),
  threadId: z.string().uuid(),
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
  program: z.enum(["shell", "claude-login", "codex-login"]).optional(),
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

export const Command = z.discriminatedUnion("type", [
  ProjectCreate,
  ProjectStart,
  ProjectStop,
  ProjectDelete,
  ThreadCreate,
  ThreadSend,
  ThreadCancel,
  ThreadRevert,
  ThreadFork,
  TerminalCreate,
  TerminalInput,
  TerminalResize,
  TerminalClose,
  FileWrite,
  GitCommit,
  GitPush,
  PreviewPublish,
  PreviewDelete,
]);

export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
