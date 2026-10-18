import { z } from "zod";
import { Command, type CommandType } from "./commands.js";
import { ComposerDraft, DomainEvent, StoredEvent } from "./events.js";

/**
 * The client/server wire contract: one authenticated WebSocket carrying
 * request/response frames plus server-pushed subscription frames.
 *
 * Holding a valid socket is not authorization to call everything on it --
 * every method is gated by `REQUIRED_SCOPE` below.
 */

export const Scope = z.enum(["read", "write", "exec", "admin"]);
export type Scope = z.infer<typeof Scope>;

// -- Client -> server --------------------------------------------------------

const Dispatch = z.object({
  kind: z.literal("dispatch"),
  id: z.string(),
  command: Command,
});

const Subscribe = z.object({
  kind: z.literal("subscribe"),
  id: z.string(),
  topic: z.discriminatedUnion("name", [
    z.object({ name: z.literal("thread"), threadId: z.string().uuid() }),
    z.object({
      name: z.literal("project"),
      projectId: z.string().uuid(),
      /**
       * Leaves out the streams -- token deltas and terminal bytes -- for a
       * view that only wants to hear that something changed, so a page of
       * notes is not sent every token of a running agent.
       */
      quiet: z.boolean().optional(),
    }),
    z.object({ name: z.literal("terminal"), terminalId: z.string() }),
    /** The caller's own account: settings and other things without a project. */
    z.object({ name: z.literal("user") }),
  ]),
  /** Replay durable events from this sequence number before streaming live ones. */
  sinceSeq: z.number().int().nonnegative().optional(),
});

const Unsubscribe = z.object({
  kind: z.literal("unsubscribe"),
  id: z.string(),
});

/**
 * What this tab has typed in a thread's prompt box. Not a command: a draft
 * is not a fact for the log, only shared state the server holds while
 * anyone is looking. `baseRev` is the rev this tab last saw; an update made
 * against an older one is refused with `conflict`.
 */
const ComposerUpdate = z.object({
  kind: z.literal("composer"),
  id: z.string(),
  threadId: z.string().uuid(),
  baseRev: z.number().int().nonnegative(),
  draft: ComposerDraft,
});

/** Where this tab is looking in a project, or null to leave it. */
const PresenceSet = z.object({
  kind: z.literal("presence"),
  id: z.string(),
  projectId: z.string().uuid(),
  location: z.string().max(600).nullable(),
  editing: z.boolean().optional(),
});

const Ping = z.object({
  kind: z.literal("ping"),
  id: z.string(),
});

export const ClientFrame = z.discriminatedUnion("kind", [
  Dispatch,
  Subscribe,
  Unsubscribe,
  ComposerUpdate,
  PresenceSet,
  Ping,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// -- Server -> client --------------------------------------------------------

const Ack = z.object({
  kind: z.literal("ack"),
  id: z.string(),
  events: z.array(StoredEvent),
});

const Err = z.object({
  kind: z.literal("error"),
  id: z.string().nullable(),
  code: z.enum(["unauthorized", "forbidden", "not_found", "invalid", "conflict", "internal"]),
  message: z.string(),
});

/**
 * An event on a subscribed topic. `seq` is null for transient events.
 *
 * `at` is when the event happened: its `createdAt` for one replayed from the
 * log, the moment of publication for a live one. Without it a client that
 * reloads would date every past turn to the reload, and "done 6:42 PM" under
 * a message would read "done just now" for the whole history. Optional so a
 * server that predates it still speaks the protocol.
 */
const Push = z.object({
  kind: z.literal("push"),
  subscriptionId: z.string(),
  seq: z.number().int().nonnegative().nullable(),
  at: z.string().datetime().optional(),
  /**
   * The project the event belongs to. A thread's events name only the
   * thread, so without this a view watching several projects -- the
   * sidebar's agent badges -- could not tell whose turn just ended.
   * Absent on the user's own topic, which belongs to no project.
   */
  projectId: z.string().uuid().optional(),
  event: DomainEvent,
});

const Pong = z.object({
  kind: z.literal("pong"),
  id: z.string(),
  serverTime: z.string().datetime(),
});

const Ready = z.object({
  kind: z.literal("ready"),
  userId: z.string().uuid(),
  scopes: z.array(Scope),
  serverVersion: z.string(),
});

export const ServerFrame = z.discriminatedUnion("kind", [Ack, Err, Push, Pong, Ready]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// -- Authorization -----------------------------------------------------------

/**
 * Every command maps to the scope required to dispatch it. A command missing
 * from this map is rejected -- adding a command without deciding its
 * authorization is a bug, not a default-allow.
 */
export const REQUIRED_SCOPE: Record<CommandType, Scope> = {
  "project.create": "write",
  "project.start": "exec",
  "project.stop": "exec",
  "project.delete": "admin",
  "thread.create": "write",
  "thread.send": "exec",
  "thread.cancel": "exec",
  "thread.permission_reply": "exec",
  "thread.revert": "write",
  "thread.fork": "write",
  "terminal.create": "exec",
  "terminal.input": "exec",
  "terminal.resize": "exec",
  "terminal.close": "exec",
  "file.write": "write",
  "git.commit": "write",
  "git.push": "admin",
  "preview.publish": "write",
  "preview.delete": "write",
};

const IMPLIED: Record<Scope, readonly Scope[]> = {
  read: ["read"],
  write: ["read", "write"],
  exec: ["read", "write", "exec"],
  admin: ["read", "write", "exec", "admin"],
};

export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  return granted.some((g) => IMPLIED[g].includes(required));
}
