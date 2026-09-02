import { z } from "zod";
import { Command, type CommandType } from "./commands.js";
import { DomainEvent, StoredEvent } from "./events.js";

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
    z.object({ name: z.literal("project"), projectId: z.string().uuid() }),
    z.object({ name: z.literal("terminal"), terminalId: z.string() }),
  ]),
  /** Replay durable events from this sequence number before streaming live ones. */
  sinceSeq: z.number().int().nonnegative().optional(),
});

const Unsubscribe = z.object({
  kind: z.literal("unsubscribe"),
  id: z.string(),
});

const Ping = z.object({
  kind: z.literal("ping"),
  id: z.string(),
});

export const ClientFrame = z.discriminatedUnion("kind", [Dispatch, Subscribe, Unsubscribe, Ping]);
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

/** A live event on a subscribed topic. `seq` is null for transient events. */
const Push = z.object({
  kind: z.literal("push"),
  subscriptionId: z.string(),
  seq: z.number().int().nonnegative().nullable(),
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
