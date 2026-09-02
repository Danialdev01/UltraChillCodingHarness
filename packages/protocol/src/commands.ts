import { z } from "zod";
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
  repoUrl: z.string().url(),
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

/** Queues an agent turn. The turn itself runs in `AgentTurnReactor`. */
const ThreadSend = z.object({
  type: z.literal("thread.send"),
  threadId: z.string().uuid(),
  text: z.string().min(1),
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
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
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
