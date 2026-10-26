import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Command, Scope, ServerFrame } from "@ucch/protocol";
import { EventBus } from "./bus.js";
import { terminalFrame, WebSocketGateway } from "./ws.js";
import type { AuthService, Principal } from "./auth.js";
import type { ComposerStore } from "./composer.js";
import type { EventStore, RawStoredEvent } from "./eventstore.js";
import type { OrchestrationEngine } from "./engine.js";
import { PresenceStore } from "./presence.js";

/**
 * The terminal fast path: keystrokes and resizes as their own frames, read
 * without the schema and answered with nothing, next to the old
 * `dispatch terminal.input` they replace.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const TERMINAL = "77777777-7777-7777-7777-777777777777";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const WORKSPACE = "55555555-5555-5555-5555-555555555555";

let server: Server;
let gateway: WebSocketGateway;
/** What reached the terminals, one line per call. */
let delivered: string[];
/** Whether the terminals accept what they are sent. */
let accept: boolean;
let dispatched: Command[];
/** How long finding a thread command's queue takes. */
let slowKeyMs: number;
/** What the file watcher was told, one line per call. */
let watches: string[];
let bus: EventBus;
/** The thread's log, as the store reads it for a replay. */
let history: RawStoredEvent[];
/** Runs while the replay's read is in flight: what is published meanwhile. */
let duringRead: () => void;
/** Turns ahead of THREAD's waiting one, as the scheduler would say. */
let queued: number | null;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  delivered = [];
  accept = true;
  dispatched = [];
  slowKeyMs = 0;
  watches = [];
  history = [];
  duringRead = () => {};
  queued = null;
  bus = new EventBus();
  const auth = {
    // The ticket is the user id, with the scopes after a colon.
    redeemTicket: (ticket?: string): Principal | null => {
      if (!ticket) return null;
      const [userId, scopes] = ticket.split(":");
      return {
        userId: userId!,
        sessionId: userId!,
        scopes: (scopes ? scopes.split(",") : ["read", "write", "exec"]) as Scope[],
      };
    },
  } as unknown as AuthService;
  const engine = {
    // A thread's queue takes a moment to find, as the real one may.
    keyOf: async (command: Command) => {
      if ("threadId" in command) await new Promise((r) => setTimeout(r, slowKeyMs));
      return "k";
    },
    dispatch: async (_principal: Principal, command: Command) => {
      dispatched.push(command);
      return { ok: true, events: [] };
    },
  } as unknown as OrchestrationEngine;
  const after = (sinceSeq: number) => history.filter((row) => row.seq > sinceSeq);
  const store = {
    readThreadRaw: async (_threadId: string, sinceSeq: number) => {
      duringRead();
      return after(sinceSeq);
    },
    readThread: async (_threadId: string, sinceSeq: number) => {
      duringRead();
      return after(sinceSeq).map((row) => ({
        id: String(row.seq),
        projectId: row.projectId,
        threadId: THREAD,
        seq: row.seq,
        createdAt: row.createdAt,
        event: JSON.parse(row.payload),
      }));
    },
  } as unknown as EventStore;
  gateway = new WebSocketGateway(auth, engine, store, bus, {
    access: {
      canAccessProject: async () => true,
      canAccessWorkspace: async () => true,
      threadProject: async (_userId, threadId) => (threadId === THREAD ? PROJECT : null),
      projectOfThread: async () => null,
    },
    onProjectWatch: (projectId, delta, tree) => watches.push(`${delta > 0 ? "+" : "-"}${projectId}${tree ? `/${tree}` : ""}`),
    buildId: "build-7",
    queuedAhead: (threadId) => (threadId === THREAD ? queued : null),
    composer: { get: () => ({ rev: 0, draft: { text: "" }, origin: null }) } as unknown as ComposerStore,
    presence: new PresenceStore(),
    terminals: {
      input: (terminalId, userId, data) => {
        delivered.push(`input ${terminalId} ${userId} ${JSON.stringify(data)}`);
        return accept;
      },
      resize: (terminalId, userId, cols, rows) => {
        delivered.push(`resize ${terminalId} ${userId} ${cols}x${rows}`);
        return accept;
      },
    },
  });
  server = createServer();
  server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Peer {
  frames: ServerFrame[];
  /** Each frame's size in bytes, in the order of `frames`. */
  sizes: number[];
  raw(text: string): void;
  send(frame: object): void;
  /** Everything the server sent in answer to what was sent so far, ready frame aside. */
  settle(): Promise<ServerFrame[]>;
  /** Everything the server sent until frame `id` was answered, ready frame aside. */
  acked(id: string): Promise<ServerFrame[]>;
}

async function connect(ticket = ALICE, query = ""): Promise<Peer> {
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}${query}`);
  sockets.push(socket);
  const frames: ServerFrame[] = [];
  const sizes: number[] = [];
  socket.on("message", (raw) => {
    sizes.push((raw as Buffer).length);
    frames.push(JSON.parse(raw.toString()) as ServerFrame);
  });
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  let pings = 0;
  const peer: Peer = {
    frames,
    sizes,
    raw: (text) => socket.send(text),
    send: (frame) => socket.send(JSON.stringify(frame)),
    // Frames are handled in order, and the fast path without awaiting: once
    // a ping sent after them is answered, every answer they got is in.
    acked: async (id) => {
      const deadline = Date.now() + 2000;
      while (!frames.some((f) => (f.kind === "ack" || f.kind === "error") && f.id === id)) {
        if (Date.now() > deadline) throw new Error(`no answer to ${id}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return frames.filter((f) => f.kind !== "ready" && f.kind !== "pong");
    },
    settle: async () => {
      const id = `settle-${++pings}`;
      socket.send(JSON.stringify({ kind: "ping", id }));
      const deadline = Date.now() + 1000;
      while (!frames.some((f) => f.kind === "pong" && f.id === id)) {
        if (Date.now() > deadline) throw new Error("no pong");
        await new Promise((r) => setTimeout(r, 5));
      }
      return frames.filter((f) => f.kind !== "ready" && f.kind !== "pong");
    },
  };
  return peer;
}

describe("terminal frames", () => {
  it("take keystrokes and sizes to the terminal with nothing sent back", async () => {
    const alice = await connect();
    alice.send({ kind: "terminal_input", terminalId: TERMINAL, data: "ls\r" });
    alice.send({ kind: "terminal_resize", terminalId: TERMINAL, cols: 120, rows: 40 });
    expect(await alice.settle()).toEqual([]);
    expect(delivered).toEqual([`input ${TERMINAL} ${ALICE} "ls\\r"`, `resize ${TERMINAL} ${ALICE} 120x40`]);
    expect(dispatched).toEqual([]);
  });

  it("take a frame written in another order, through the schema", async () => {
    const alice = await connect();
    alice.raw(JSON.stringify({ terminalId: TERMINAL, data: "x", kind: "terminal_input" }));
    expect(await alice.settle()).toEqual([]);
    expect(delivered).toEqual([`input ${TERMINAL} ${ALICE} "x"`]);
  });

  it("refuse a malformed one, once in a while rather than per frame", async () => {
    const alice = await connect();
    alice.send({ kind: "terminal_input", terminalId: TERMINAL, data: 42 });
    alice.send({ kind: "terminal_input", terminalId: TERMINAL, data: "x".repeat(64 * 1024 + 1) });
    alice.send({ kind: "terminal_resize", terminalId: TERMINAL, cols: 0, rows: 40 });
    alice.raw('{"kind":"terminal_input",');
    const answers = await alice.settle();
    expect(answers).toEqual([{ kind: "error", id: null, code: "invalid", message: expect.any(String) }]);
    expect(delivered).toEqual([]);
  });

  it("say once that the terminal is not there", async () => {
    accept = false;
    const alice = await connect();
    for (const ch of "abc") alice.send({ kind: "terminal_input", terminalId: TERMINAL, data: ch });
    expect(await alice.settle()).toEqual([{ kind: "error", id: null, code: "not_found", message: expect.any(String) }]);
    expect(delivered).toHaveLength(3);
  });

  it("need the scope a terminal command needs", async () => {
    const reader = await connect(`${ALICE}:read,write`);
    reader.send({ kind: "terminal_input", terminalId: TERMINAL, data: "x" });
    expect(await reader.settle()).toEqual([{ kind: "error", id: null, code: "forbidden", message: expect.any(String) }]);
    expect(delivered).toEqual([]);
  });

  it("leave `dispatch terminal.input` working for a tab loaded before them", async () => {
    const alice = await connect();
    alice.send({ kind: "dispatch", id: "1", command: { type: "terminal.input", terminalId: TERMINAL, data: "x" } });
    expect(await alice.settle()).toEqual([{ kind: "ack", id: "1", events: [] }]);
    expect(dispatched).toEqual([{ type: "terminal.input", terminalId: TERMINAL, data: "x" }]);
  });
});

describe("terminalFrame", () => {
  it("reads the two kinds and nothing else", () => {
    expect(terminalFrame('{"kind":"terminal_input","terminalId":"t","data":"\\u0003"}')).toEqual({
      kind: "terminal_input",
      terminalId: "t",
      data: "\u0003",
    });
    expect(terminalFrame('{"kind":"terminal_resize","terminalId":"t","cols":80,"rows":24}')).toEqual({
      kind: "terminal_resize",
      terminalId: "t",
      cols: 80,
      rows: 24,
    });
    expect(terminalFrame('{"kind":"terminal_close","terminalId":"t"}')).toBeNull();
    expect(terminalFrame('{"kind":"terminal_resize","terminalId":"t","cols":80.5,"rows":24}')).toBeNull();
    expect(terminalFrame(`{"kind":"terminal_input","terminalId":"${"t".repeat(65)}","data":""}`)).toBeNull();
    expect(terminalFrame("null")).toBeNull();
  });
});

describe("dispatch", () => {
  it("queues a socket's commands in the order they were sent, however long each takes to place", async () => {
    slowKeyMs = 30;
    const alice = await connect();
    const thread = "44444444-4444-4444-4444-444444444444";
    alice.send({ kind: "dispatch", id: "1", command: { type: "thread.cancel", threadId: thread } });
    alice.send({ kind: "dispatch", id: "2", command: { type: "terminal.close", terminalId: TERMINAL } });
    const deadline = Date.now() + 1000;
    while (alice.frames.filter((f) => f.kind === "ack").length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(dispatched.map((command) => command.type)).toEqual(["thread.cancel", "terminal.close"]);
  });
});

describe("ready", () => {
  it("says which build the server is", async () => {
    const alice = await connect();
    await alice.settle();
    expect(alice.frames.find((frame) => frame.kind === "ready")).toMatchObject({ userId: ALICE, buildId: "build-7" });
  });
});

describe("project subscriptions and the file watcher", () => {
  it("leave the watcher alone when quiet, or not asking for files", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT, quiet: true } });
    alice.send({ kind: "subscribe", id: "2", topic: { name: "project", projectId: PROJECT } });
    await alice.settle();
    alice.send({ kind: "unsubscribe", id: "1" });
    alice.send({ kind: "unsubscribe", id: "2" });
    await alice.settle();
    expect(watches).toEqual([]);
  });

  it("keep it going for as long as a `files: true` one lasts", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT, quiet: true, files: true } });
    await alice.settle();
    expect(watches).toEqual([`+${PROJECT}`]);
    alice.send({ kind: "unsubscribe", id: "1" });
    await alice.settle();
    expect(watches).toEqual([`+${PROJECT}`, `-${PROJECT}`]);
  });

  it("watch a session's worktree when the subscription names it", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT, quiet: true, files: true, tree: "abc123def456" } });
    await alice.settle();
    alice.send({ kind: "unsubscribe", id: "1" });
    await alice.settle();
    expect(watches).toEqual([`+${PROJECT}/abc123def456`, `-${PROJECT}/abc123def456`]);
  });

  it("refuse a tree that is not a session hash", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT, files: true, tree: "../../etc" } });
    const frames = await alice.settle();
    expect(frames).toContainEqual(expect.objectContaining({ kind: "error", code: "invalid" }));
    expect(watches).toEqual([]);
  });

  it("let it go when the socket closes", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT, files: true } });
    await alice.settle();
    sockets.at(-1)!.close();
    const deadline = Date.now() + 1000;
    while (watches.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(watches).toEqual([`+${PROJECT}`, `-${PROJECT}`]);
  });
});

describe("project.activity", () => {
  it("reaches the workspace's subscribers and not the project's", async () => {
    const alice = await connect();
    alice.send({ kind: "subscribe", id: "w", topic: { name: "workspace", workspaceId: WORKSPACE } });
    alice.send({ kind: "subscribe", id: "p", topic: { name: "project", projectId: PROJECT, quiet: true } });
    await alice.settle();
    const event = { type: "project.activity", projectId: PROJECT, threadId: THREAD, state: "running" } as const;
    bus.publishToWorkspace(WORKSPACE, event);
    const pushes = (await alice.settle()).filter((f) => f.kind === "push" && f.event.type === "project.activity");
    expect(pushes).toEqual([expect.objectContaining({ kind: "push", subscriptionId: "w", event })]);
  });
});

describe("thread replay", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  /** `count` logged messages of about `size` bytes each, seq 0 up. */
  const log = (count: number, size = 100) =>
    Array.from({ length: count }, (_, seq) => ({
      seq,
      projectId: PROJECT,
      createdAt: AT,
      payload: JSON.stringify({ type: "user.message", threadId: THREAD, text: `${seq} ${"x".repeat(size)}` }),
    }));
  const subscribe = { kind: "subscribe", id: "s", topic: { name: "thread", threadId: THREAD } };

  it("sends a thousand events in a few frames, in order, each at most 256 KB", async () => {
    history = log(1000, 1000);
    const alice = await connect(ALICE, "&caps=replay1");
    alice.send(subscribe);
    const frames = await alice.acked("s");
    const replays = frames.filter((f) => f.kind === "replay");
    expect(replays.length).toBeLessThanOrEqual(5);
    expect(replays.map((f) => f.done)).toEqual([...replays.slice(1).map(() => false), true]);
    expect(replays.flatMap((f) => f.events.map((e) => e.seq))).toEqual(history.map((row) => row.seq));
    expect(replays[0]!.events[0]).toEqual({ seq: 0, at: AT, projectId: PROJECT, event: JSON.parse(history[0]!.payload) });
    const sizes = alice.frames.flatMap((f, i) => (f.kind === "replay" ? [alice.sizes[i]!] : []));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
    expect(frames.filter((f) => f.kind === "push" && f.event.type === "user.message")).toEqual([]);
  });

  it("follows it with what was published meanwhile, once each", async () => {
    history = log(3);
    const delta = { type: "agent.text_delta", threadId: THREAD, turnId: THREAD, text: "x" } as const;
    const message = (seq: number) => ({ type: "user.message", threadId: THREAD, text: `${seq}` }) as const;
    duringRead = () => {
      bus.publish({ seq: 2, projectId: PROJECT, threadId: THREAD, event: message(2) });
      bus.publish({ seq: 3, projectId: PROJECT, threadId: THREAD, event: message(3) });
      bus.publish({ seq: null, projectId: PROJECT, threadId: THREAD, event: delta });
    };
    const alice = await connect(ALICE, "&caps=replay1");
    alice.send(subscribe);
    const frames = await alice.acked("s");
    const order = frames.flatMap((f) => {
      if (f.kind === "replay") return [`replay ${f.events.map((e) => e.seq).join(",")}`];
      return f.kind === "push" && f.event.type !== "composer.changed" ? [`push ${f.seq}`] : [];
    });
    expect(order).toEqual(["replay 0,1,2", "push 3", "push null"]);
  });

  it("resumes after `sinceSeq`, and sends nothing when there is nothing newer", async () => {
    history = log(5);
    const alice = await connect(ALICE, "&caps=replay1");
    alice.send({ ...subscribe, sinceSeq: 2 });
    const first = await alice.acked("s");
    expect(first.filter((f) => f.kind === "replay").flatMap((f) => f.events.map((e) => e.seq))).toEqual([3, 4]);
    alice.send({ ...subscribe, id: "t", sinceSeq: 4 });
    const second = (await alice.acked("t")).slice(first.length);
    expect(second.filter((f) => f.kind === "replay")).toEqual([]);
  });

  it("is one push an event for a client that did not ask for batches", async () => {
    history = log(3);
    const alice = await connect();
    alice.send(subscribe);
    const frames = await alice.acked("s");
    expect(frames.some((f) => f.kind === "replay")).toBe(false);
    const pushes = frames.filter((f) => f.kind === "push" && f.event.type === "user.message");
    expect(pushes.map((f) => (f.kind === "push" ? [f.seq, f.at, f.projectId] : []))).toEqual([
      [0, AT, PROJECT],
      [1, AT, PROJECT],
      [2, AT, PROJECT],
    ]);
  });

  it("says, after the history, how many are ahead of a turn still waiting for a slot", async () => {
    history = log(1);
    queued = 3;
    const alice = await connect(ALICE, "&caps=replay1");
    alice.send(subscribe);
    const frames = await alice.acked("s");
    const kinds = frames.map((f) => (f.kind === "push" ? f.event.type : f.kind));
    expect(kinds).toEqual(["replay", "composer.changed", "agent.queued", "ack"]);
    expect(frames[2]).toMatchObject({ seq: null, projectId: PROJECT, event: { type: "agent.queued", threadId: THREAD, ahead: 3 } });
  });
});
