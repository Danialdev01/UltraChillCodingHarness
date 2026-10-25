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
      /**
       * Keeps the project's file watcher running for as long as this
       * subscription lasts, so changes made outside the server -- a
       * terminal, a dev server, git -- arrive as `file.changed`. Only views
       * that show files ask for it: every watched project is an inotify
       * watch on the server.
       */
      files: z.boolean().optional(),
    }),
    z.object({ name: z.literal("terminal"), terminalId: z.string() }),
    /** The caller's own account: settings and other things without a project. */
    z.object({ name: z.literal("user") }),
    /**
     * A workspace the caller belongs to: its projects, members, invites,
     * connections and settings -- what every member's sidebar shows.
     */
    z.object({ name: z.literal("workspace"), workspaceId: z.string().uuid() }),
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

/** The most a `terminal_input` frame carries; a longer paste is sent in pieces. */
export const TERMINAL_INPUT_MAX = 64 * 1024;

/**
 * A thread's newest durable events: what the server replays when a thread
 * is subscribed to, and what the browser keeps of one. One number, so the
 * browser never keeps less than it was sent.
 */
export const THREAD_WINDOW = 1000;

/**
 * Keystrokes into a terminal, outside the command queue: no id, no ack.
 * `dispatch terminal.input` does the same, but waits behind every other
 * command and answers each key with an ack nothing reads.
 */
const TerminalInputFrame = z.object({
  kind: z.literal("terminal_input"),
  terminalId: z.string().max(64),
  data: z.string().max(TERMINAL_INPUT_MAX),
});

/** A terminal's new size, the same way as `terminal_input`. */
const TerminalResizeFrame = z.object({
  kind: z.literal("terminal_resize"),
  terminalId: z.string().max(64),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const ClientFrame = z.discriminatedUnion("kind", [
  Dispatch,
  Subscribe,
  Unsubscribe,
  ComposerUpdate,
  PresenceSet,
  Ping,
  TerminalInputFrame,
  TerminalResizeFrame,
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

/**
 * A thread's logged history, many events to a frame: what a thread
 * subscription replays to a client that connected with `caps=replay1`
 * (`REPLAY_CAP`). One push per event was a thousand frames, and a thousand
 * serializations on the server, for every long thread opened. `done` is set
 * on the last of them. Live events that arrived meanwhile follow as pushes.
 */
const Replay = z.object({
  kind: z.literal("replay"),
  subscriptionId: z.string(),
  events: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      at: z.string().datetime(),
      projectId: z.string().uuid().optional(),
      event: DomainEvent,
    }),
  ),
  done: z.boolean(),
});

/** In the socket URL's `caps`: this client reads `replay` frames. */
export const REPLAY_CAP = "replay1";

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
  /**
   * The server's build, when it was given one. A tab running another build
   * of the web app is out of date (`client.ts`).
   */
  buildId: z.string().optional(),
});

/**
 * A subscription the server ended: the caller lost access to what it was
 * watching -- removed from the workspace, the project deleted. The client
 * drops it and must not resubscribe.
 */
const Revoked = z.object({
  kind: z.literal("revoked"),
  subscriptionId: z.string(),
});

export const ServerFrame = z.discriminatedUnion("kind", [Ack, Err, Push, Replay, Pong, Ready, Revoked]);
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
