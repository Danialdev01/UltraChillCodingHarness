import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { DomainEvent, ServerFrame } from "@ucch/protocol";
import { EventBus } from "./bus.js";
import { WebSocketGateway } from "./ws.js";
import type { AuthService, Principal } from "./auth.js";
import type { ComposerStore } from "./composer.js";
import type { EventStore } from "./eventstore.js";
import type { OrchestrationEngine } from "./engine.js";
import { registry } from "./metrics.js";
import { PresenceStore } from "./presence.js";

/**
 * Who hears what on the socket: the gateway's access checks end to end, over
 * a real WebSocket, with the database stood in for by a membership table.
 */

const PROJECT = "33333333-3333-3333-3333-333333333333";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const TERMINAL = "77777777-7777-7777-7777-777777777777";
const WORKSPACE = "44444444-4444-4444-4444-444444444444";

let server: Server;
let bus: EventBus;
let gateway: WebSocketGateway;
let members: Set<string>;
let terminalOwners: Map<string, string>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  bus = new EventBus();
  members = new Set([ALICE, BOB]);
  terminalOwners = new Map();
  const auth = {
    // The ticket is the user id, with the session after a colon.
    redeemTicket: (ticket?: string): Principal | null => {
      if (!ticket) return null;
      const [userId, sessionId] = ticket.split(":");
      return { userId: userId!, sessionId: sessionId ?? userId!, scopes: ["read", "write", "exec"] };
    },
  } as unknown as AuthService;
  gateway = new WebSocketGateway(auth, {} as OrchestrationEngine, {} as EventStore, bus, {
    access: {
      canAccessProject: async (userId: string) => members.has(userId),
      canAccessWorkspace: async (userId: string) => members.has(userId),
      threadProject: async () => null,
      projectOfThread: async () => null,
    },
    composer: {} as ComposerStore,
    presence: new PresenceStore(),
    mayWatchTerminal: (userId, terminalId) => {
      const owner = terminalOwners.get(terminalId);
      if (owner) return owner === userId;
      terminalOwners.set(terminalId, userId);
      return true;
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
  send(frame: object): void;
  closed: Promise<number>;
  /** Resolves with the first frame matching, or rejects after a second. */
  next(match: (f: ServerFrame) => boolean): Promise<ServerFrame>;
}

async function connect(ticket: string): Promise<Peer> {
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
  sockets.push(socket);
  const frames: ServerFrame[] = [];
  const waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as ServerFrame;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.match(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  const peer: Peer = {
    frames,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: (match) =>
      new Promise((resolve, reject) => {
        const found = frames.find(match);
        if (found) return resolve(found);
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error("no such frame")), 1000);
      }),
  };
  await peer.next((f) => f.kind === "ready");
  return peer;
}

const ackOf = (id: string) => (f: ServerFrame) => (f.kind === "ack" || f.kind === "error") && f.id === id;

const note = (data: string): DomainEvent =>
  ({ type: "terminal.output", projectId: PROJECT, terminalId: TERMINAL, data }) as DomainEvent;

describe("realtime access", () => {
  it("refuses a project to someone outside its workspace", async () => {
    members.delete(BOB);
    const bob = await connect(BOB);
    bob.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT } });
    expect(await bob.next(ackOf("1"))).toMatchObject({ kind: "error", code: "forbidden" });
  });

  it("does not let one member read another member's terminal", async () => {
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    alice.send({ kind: "subscribe", id: "1", topic: { name: "terminal", terminalId: TERMINAL } });
    expect(await alice.next(ackOf("1"))).toMatchObject({ kind: "ack" });
    bob.send({ kind: "subscribe", id: "1", topic: { name: "terminal", terminalId: TERMINAL } });
    expect(await bob.next(ackOf("1"))).toMatchObject({ kind: "error", code: "forbidden" });

    // And watching the project is no way round it.
    bob.send({ kind: "subscribe", id: "2", topic: { name: "project", projectId: PROJECT } });
    await bob.next(ackOf("2"));
    bus.publish({ seq: null, projectId: PROJECT, threadId: null, event: note("device code 1234") });
    await alice.next((f) => f.kind === "push" && f.event.type === "terminal.output");
    expect(bob.frames.some((f) => f.kind === "push" && f.event.type === "terminal.output")).toBe(false);
  });

  it("cuts a removed member off at once", async () => {
    const bob = await connect(BOB);
    bob.send({ kind: "subscribe", id: "7", topic: { name: "project", projectId: PROJECT } });
    await bob.next(ackOf("7"));

    members.delete(BOB);
    await gateway.revalidate({ userId: BOB });
    expect(await bob.next((f) => f.kind === "revoked")).toEqual({ kind: "revoked", subscriptionId: "7" });

    const before = bob.frames.length;
    bus.publish({
      seq: null,
      projectId: PROJECT,
      threadId: null,
      event: { type: "presence.changed", projectId: PROJECT, viewers: [] } as DomainEvent,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(bob.frames.slice(before).filter((f) => f.kind === "push")).toHaveLength(0);
  });

  it("leaves members who still have access alone", async () => {
    const alice = await connect(ALICE);
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT } });
    await alice.next(ackOf("1"));
    await gateway.revalidate({ projectId: PROJECT });
    expect(alice.frames.some((f) => f.kind === "revoked")).toBe(false);
  });

  it("delivers workspace events to members and refuses everyone else", async () => {
    const alice = await connect(ALICE);
    alice.send({ kind: "subscribe", id: "1", topic: { name: "workspace", workspaceId: WORKSPACE } });
    expect(await alice.next(ackOf("1"))).toMatchObject({ kind: "ack" });
    bus.publishToWorkspace(WORKSPACE, {
      type: "resource.changed",
      projectId: null,
      resource: "projects",
    } as DomainEvent);
    expect(await alice.next((f) => f.kind === "push")).toMatchObject({ subscriptionId: "1" });

    members.delete(BOB);
    const bob = await connect(BOB);
    bob.send({ kind: "subscribe", id: "1", topic: { name: "workspace", workspaceId: WORKSPACE } });
    expect(await bob.next(ackOf("1"))).toMatchObject({ kind: "error", code: "forbidden" });
  });

  it("revokes a workspace subscription when the member is removed", async () => {
    const bob = await connect(BOB);
    bob.send({ kind: "subscribe", id: "3", topic: { name: "workspace", workspaceId: WORKSPACE } });
    await bob.next(ackOf("3"));
    members.delete(BOB);
    await gateway.revalidate({ userId: BOB });
    expect(await bob.next((f) => f.kind === "revoked")).toEqual({ kind: "revoked", subscriptionId: "3" });
  });

  it("closes a signed-out session's sockets, and only those", async () => {
    const phone = await connect(`${ALICE}:phone`);
    const laptop = await connect(`${ALICE}:laptop`);
    gateway.closeSession("phone");
    expect(await phone.closed).toBe(4001);
    await new Promise((r) => setTimeout(r, 50));
    expect(laptop.frames.length).toBeGreaterThan(0);
    expect(sockets[1]!.readyState).toBe(WebSocket.OPEN);
  });
});

describe("socket metrics", () => {
  it("counts subscriptions by topic kind, and frames in and out", async () => {
    const alice = await connect(ALICE);
    alice.send({ kind: "subscribe", id: "1", topic: { name: "project", projectId: PROJECT } });
    alice.send({ kind: "subscribe", id: "2", topic: { name: "terminal", terminalId: TERMINAL } });
    await alice.next(ackOf("1"));
    await alice.next(ackOf("2"));
    expect(Object.fromEntries(gateway.subscriptionCounts())).toEqual({ project: 1, terminal: 1 });

    // The unsubscribe is acked under the subscription's own id, so it is the second ack for "2".
    const acksOf2 = () => alice.frames.filter((f) => f.kind === "ack" && f.id === "2").length;
    alice.send({ kind: "unsubscribe", id: "2" });
    await alice.next(() => acksOf2() === 2);
    expect(Object.fromEntries(gateway.subscriptionCounts())).toEqual({ project: 1 });

    alice.send({ not: "a frame" });
    await alice.next((f) => f.kind === "error" && f.code === "invalid");
    const presence: DomainEvent = { type: "presence.changed", projectId: PROJECT, viewers: [] };
    bus.publish({ seq: null, projectId: PROJECT, threadId: null, event: presence });
    await alice.next((f) => f.kind === "push" && f.event.type === "presence.changed");

    const text = await registry.render();
    expect(text).toMatch(/ws_frames_in_total\{kind="subscribe"\} \d+/);
    expect(text).toMatch(/ws_frames_in_total\{kind="invalid"\} \d+/);
    expect(text).toMatch(/ws_frames_out_total\{kind="push",event="presence.changed"\} \d+/);
    expect(text).toMatch(/ws_bytes_out_total\{kind="push"\} \d+/);
  });
});
