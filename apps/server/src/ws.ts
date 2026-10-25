import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientFrame,
  hasScope,
  REPLAY_CAP,
  REQUIRED_SCOPE,
  TERMINAL_INPUT_MAX,
  THREAD_WINDOW,
  type Command,
  type DomainEvent,
  type ServerFrame,
  type StoredEvent,
} from "@ucch/protocol";
import type { ProjectAccess } from "./access.js";
import type { AuthService, Principal } from "./auth.js";
import type { EventBus, Topic } from "./bus.js";
import type { ComposerState, ComposerStore } from "./composer.js";
import type { EventStore } from "./eventstore.js";
import type { OrchestrationEngine, EngineResult } from "./engine.js";
import { registry } from "./metrics.js";
import type { PresenceStore } from "./presence.js";
import type { TerminalReactor } from "./terminals.js";

/** Newest events of a thread sent when a client subscribes to it: what the browser keeps of one. */
const REPLAY_LIMIT = THREAD_WINDOW;

/**
 * The most a `replay` frame carries. Large enough that a full replay is a
 * handful of frames, small enough that the browser parses each between two
 * of its frames' worth of work.
 */
const REPLAY_FRAME_BYTES = 256 * 1024;

/**
 * A batched replay waits between frames while the socket holds more than
 * this unsent, polling every `REPLAY_DRAIN_POLL_MS`: a long replay to a slow
 * client is then held by the client's network, not queued whole in here.
 */
const REPLAY_DRAIN_BYTES = 1024 * 1024;
const REPLAY_DRAIN_POLL_MS = 5;

const SERVER_VERSION = "0.1.0";
const HEARTBEAT_MS = 30_000;

/**
 * How a `terminal_input` or `terminal_resize` frame starts, as the client
 * writes it. Matched on the raw text so a keystroke skips the schema the
 * other frames are parsed with; a frame written another way still works,
 * through the schema.
 */
const TERMINAL_FRAME_PREFIX = '{"kind":"terminal_';

/** A socket is told at most once in this long that its terminal frames went nowhere. */
const TERMINAL_REFUSAL_MS = 5_000;

type TerminalFrame = Extract<ClientFrame, { kind: "terminal_input" | "terminal_resize" }>;

interface Connection {
  /** This socket, for presence: one person in two windows is two viewers. */
  id: string;
  socket: WebSocket;
  principal: Principal;
  /** The tab's own id, from the upgrade URL; stamped on what it changes. */
  clientId: string;
  /** What the client said it reads, from the upgrade URL's `caps`: `replay1`. */
  caps: ReadonlySet<string>;
  subscriptions: Map<string, () => void>;
  /** Each subscription's topic kind, for the subscription gauge. */
  subscriptionKinds: Map<string, Topic["name"]>;
  /** The project each project or thread subscription belongs to, to re-check on `revalidate`. */
  subscriptionProjects: Map<string, string>;
  /** The workspace each workspace subscription is for, likewise. */
  subscriptionWorkspaces: Map<string, string>;
  /** Project subscriptions with `files: true` only, for `onProjectWatch`. */
  watching: Map<string, string>;
  alive: boolean;
  /**
   * What this socket has already been allowed to open, so the prompt box,
   * sent on every pause in typing, is not a database round trip each time.
   * Thread id -> its project.
   */
  threads: Map<string, string>;
  projects: Set<string>;
  /** When this socket was last told a terminal frame was refused. */
  terminalRefusedAt: number;
  /**
   * The last of this socket's commands to be queued. Finding a command's
   * queue can take a read (a thread's project), so each waits for the one
   * before it to be queued first: the engine runs one queue's commands in
   * order, and this keeps that order the order they were sent.
   */
  order: Promise<void>;
}

/**
 * The streams a quiet project subscription leaves out: a view that only
 * wants to hear that something changed has no use for every token.
 */
const STREAMS: ReadonlySet<DomainEvent["type"]> = new Set([
  "agent.text_delta",
  "agent.thinking_delta",
  "terminal.output",
]);

export interface GatewayOptions {
  access: Pick<ProjectAccess, "canAccessProject" | "threadProject" | "projectOfThread"> &
    Partial<Pick<ProjectAccess, "canAccessWorkspace">>;
  composer: ComposerStore;
  presence: PresenceStore;
  /** A person's display name and picture, for presence. */
  profileOf?: (userId: string) => Promise<{ name: string; avatarUrl: string | null } | null>;
  /** A project subscription with `files: true` opened (+1) or closed (-1): drives the file watcher. */
  onProjectWatch?: (projectId: string, delta: 1 | -1) => void;
  /** Whether a user may watch a terminal's output; see `TerminalReactor.mayWatch`. */
  mayWatchTerminal?: (userId: string, terminalId: string) => boolean;
  /** Where `terminal_input` and `terminal_resize` frames go. Absent, they are refused. */
  terminals?: Pick<TerminalReactor, "input" | "resize">;
  /** This server's build, told to every socket in `ready` so an outdated tab can know it is. */
  buildId?: string;
  /** After a command from a socket was handled, for the activity log. */
  onDispatched?: (principal: Principal, clientId: string, command: Command, result: EngineResult) => void;
}

/**
 * One authenticated WebSocket per client, carrying commands up and events
 * down.
 *
 * Authentication happens once at the upgrade, but authorization does not:
 * holding a valid socket is not permission to call everything on it. Every
 * dispatched command is re-checked against the principal's scopes in the
 * engine.
 */
export class WebSocketGateway {
  #wss: WebSocketServer;
  #connections = new Set<Connection>();

  constructor(
    private readonly auth: AuthService,
    private readonly engine: OrchestrationEngine,
    private readonly store: EventStore,
    private readonly bus: EventBus,
    private readonly options: GatewayOptions,
  ) {
    // Client frames are subscriptions and small commands; the library's
    // 100 MiB default would let one socket make the server buffer that much.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    const heartbeat = setInterval(() => {
      for (const conn of this.#connections) {
        // A socket that missed the previous round-trip is presumed dead. Half-
        // open connections otherwise accumulate subscriptions forever.
        if (!conn.alive) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        conn.socket.ping();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
  }

  /** Handles the HTTP upgrade, redeeming the single-use ticket from the query. */
  handleUpgrade(request: IncomingMessage, socket: NodeJS.Socket & { destroy(): void }, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const principal = this.auth.redeemTicket(url.searchParams.get("ticket") ?? undefined);

    if (!principal) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const clientId = (url.searchParams.get("client") ?? "").slice(0, 64) || randomUUID();
    const caps = new Set((url.searchParams.get("caps") ?? "").slice(0, 256).split(",").filter(Boolean));
    this.#wss.handleUpgrade(request, socket as never, head, (ws) => {
      this.#accept(ws, principal, clientId, caps);
    });
  }

  #accept(socket: WebSocket, principal: Principal, clientId: string, caps: ReadonlySet<string>): void {
    const conn: Connection = {
      id: randomUUID(),
      socket,
      principal,
      clientId,
      caps,
      subscriptions: new Map(),
      subscriptionKinds: new Map(),
      subscriptionProjects: new Map(),
      subscriptionWorkspaces: new Map(),
      watching: new Map(),
      alive: true,
      threads: new Map(),
      projects: new Set(),
      terminalRefusedAt: 0,
      order: Promise.resolve(),
    };
    this.#connections.add(conn);

    socket.on("pong", () => {
      conn.alive = true;
    });

    send(socket, {
      kind: "ready",
      userId: principal.userId,
      scopes: principal.scopes,
      serverVersion: SERVER_VERSION,
      ...(this.options.buildId ? { buildId: this.options.buildId } : {}),
    });

    socket.on("message", (raw) => {
      void this.#onMessage(conn, raw.toString());
    });

    socket.on("close", () => {
      for (const id of [...conn.subscriptions.keys()]) this.#end(conn, id);
      this.#connections.delete(conn);
      for (const { projectId, viewers } of this.options.presence.drop(conn.id)) {
        this.#publish(projectId, { type: "presence.changed", projectId, viewers });
      }
    });

    socket.on("error", () => {
      // `close` always follows; cleanup happens there.
    });
  }

  async #onMessage(conn: Connection, raw: string): Promise<void> {
    // Keystrokes first, and without the schema: they are most of what a
    // socket sends while someone types, and each one is two fields.
    if (raw.startsWith(TERMINAL_FRAME_PREFIX)) {
      const frame = terminalFrame(raw);
      if (!frame) {
        framesIn.inc({ kind: "invalid" });
        this.#refuseTerminal(conn, "invalid", "malformed terminal frame");
        return;
      }
      framesIn.inc({ kind: frame.kind });
      this.#onTerminal(conn, frame);
      return;
    }

    let frame: ClientFrame;
    try {
      frame = ClientFrame.parse(JSON.parse(raw));
    } catch (error) {
      framesIn.inc({ kind: "invalid" });
      send(conn.socket, {
        kind: "error",
        id: null,
        code: "invalid",
        message: error instanceof Error ? error.message : "malformed frame",
      });
      return;
    }
    framesIn.inc({ kind: frame.kind });

    switch (frame.kind) {
      case "ping":
        send(conn.socket, { kind: "pong", id: frame.id, serverTime: new Date().toISOString() });
        return;

      case "dispatch": {
        const queued = conn.order.then(async () => {
          const key = await this.engine.keyOf(frame.command);
          return { result: this.engine.dispatch(conn.principal, frame.command, key) };
        });
        // The next command waits for this one to be queued, not handled:
        // commands for different projects still run side by side.
        conn.order = queued.then(
          () => {},
          () => {},
        );
        const result = await (await queued).result;
        if (result.ok && frame.command.type === "thread.send") {
          // The message has left the prompt box, in every window at once.
          this.#composerChanged(frame.command.threadId, this.options.composer.clear(frame.command.threadId));
        }
        try {
          this.options.onDispatched?.(conn.principal, conn.clientId, frame.command, result);
        } catch {
          // The log is a record of what happened, never a reason it did not.
        }
        if (result.ok) {
          send(conn.socket, { kind: "ack", id: frame.id, events: result.events });
        } else {
          send(conn.socket, { kind: "error", id: frame.id, code: result.code, message: result.message });
        }
        return;
      }

      case "subscribe": {
        // The client's own frame id names the subscription, so the pushes it
        // carries -- and an `unsubscribe` or `revoked` -- can be matched to
        // the topic the client asked for. Ids are per-socket counters; a
        // repeat is a broken client, given a fresh id rather than a clash.
        const subscriptionId = conn.subscriptions.has(frame.id) ? randomUUID() : frame.id;

        // Holding a socket is not permission to watch everything: a project
        // or thread must be one the caller may open, and `user` is always
        // the caller's own account.
        let topic: Topic;
        let threadProject: string | null = null;
        if (frame.topic.name === "project") {
          if (!(await this.#mayOpenProject(conn, frame.topic.projectId))) {
            send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your project" });
            return;
          }
          topic = { name: "project", projectId: frame.topic.projectId };
        } else if (frame.topic.name === "thread") {
          threadProject = await this.#mayOpenThread(conn, frame.topic.threadId);
          if (!threadProject) {
            send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your conversation" });
            return;
          }
          topic = { name: "thread", threadId: frame.topic.threadId };
        } else if (frame.topic.name === "user") {
          topic = { name: "user", userId: conn.principal.userId };
        } else if (frame.topic.name === "workspace") {
          const check = this.options.access.canAccessWorkspace;
          if (!check || !(await check.call(this.options.access, conn.principal.userId, frame.topic.workspaceId))) {
            send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your workspace" });
            return;
          }
          topic = { name: "workspace", workspaceId: frame.topic.workspaceId };
        } else {
          // A terminal id is minted by the tab that opens it and never
          // listed anywhere -- but a shell is not the place to rely on that:
          // only its owner may read what it prints.
          if (this.options.mayWatchTerminal && !this.options.mayWatchTerminal(conn.principal.userId, frame.topic.terminalId)) {
            send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your terminal" });
            return;
          }
          topic = frame.topic;
        }
        const quiet = frame.topic.name === "project" && frame.topic.quiet === true;

        // Replay durable history before attaching the live listener, so a
        // resuming client sees a continuous stream with no gap and no
        // duplicate. Events arriving during replay are buffered, not dropped.
        const buffered: StoredEvent[] = [];
        let replaying = true;

        const unsubscribe = this.bus.subscribe(topic, (publication) => {
          if (quiet && STREAMS.has(publication.event.type)) return;
          if (replaying) {
            buffered.push({
              id: "",
              projectId: publication.projectId,
              threadId: publication.threadId,
              seq: publication.seq ?? -1,
              createdAt: new Date().toISOString(),
              event: publication.event,
            });
            return;
          }
          sendPush(conn.socket, subscriptionId, publication);
        });

        conn.subscriptions.set(subscriptionId, unsubscribe);
        conn.subscriptionKinds.set(subscriptionId, frame.topic.name);
        const watched = frame.topic.name === "project" ? frame.topic.projectId : threadProject;
        if (watched) conn.subscriptionProjects.set(subscriptionId, watched);
        if (frame.topic.name === "workspace") conn.subscriptionWorkspaces.set(subscriptionId, frame.topic.workspaceId);
        // Only a view that shows files keeps the watcher going: a sidebar or
        // a board listening to the project has no use for changes on disk.
        if (frame.topic.name === "project" && frame.topic.files === true) {
          conn.watching.set(subscriptionId, frame.topic.projectId);
          this.options.onProjectWatch?.(frame.topic.projectId, 1);
        }

        if (frame.topic.name === "thread") {
          // Bounded: the browser keeps the newest THREAD_WINDOW events of a
          // thread, so replaying the whole of a long one is frames it would
          // discard.
          const seen = conn.caps.has(REPLAY_CAP)
            ? await this.#replayBatched(conn, subscriptionId, frame.topic.threadId, frame.sinceSeq ?? -1)
            : await this.#replayEach(conn, subscriptionId, frame.topic.threadId, frame.sinceSeq ?? -1);
          for (const stored of buffered) {
            if (stored.seq >= 0 && seen.has(stored.seq)) continue;
            send(conn.socket, {
              kind: "push",
              subscriptionId,
              seq: stored.seq < 0 ? null : stored.seq,
              at: stored.createdAt,
              ...(stored.projectId ? { projectId: stored.projectId } : {}),
              event: stored.event,
            });
          }
        }

        replaying = false;

        // Live state that is not in the log: what is being typed in the
        // thread's prompt box, and who else has the project open.
        if (frame.topic.name === "thread" && threadProject) {
          const state = this.options.composer.get(frame.topic.threadId);
          send(conn.socket, {
            kind: "push",
            subscriptionId,
            seq: null,
            event: composerEvent(threadProject, frame.topic.threadId, state),
          });
        }
        if (frame.topic.name === "project") {
          const projectId = frame.topic.projectId;
          send(conn.socket, {
            kind: "push",
            subscriptionId,
            seq: null,
            event: { type: "presence.changed", projectId, viewers: this.options.presence.list(projectId) },
          });
        }

        send(conn.socket, { kind: "ack", id: frame.id, events: [] });
        return;
      }

      case "composer": {
        const projectId = await this.#mayOpenThread(conn, frame.threadId);
        if (!projectId) {
          send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your conversation" });
          return;
        }
        const result = this.options.composer.update(frame.threadId, frame.baseRev, frame.draft, {
          userId: conn.principal.userId,
          clientId: conn.clientId,
        });
        if (!result.ok) {
          // The tab is shown what won before it is told it lost, so the
          // revert it does on the error is to the right text.
          this.#composerChanged(frame.threadId, result.state, projectId, conn);
          send(conn.socket, {
            kind: "error",
            id: frame.id,
            code: "conflict",
            message: "The prompt was changed in another window.",
          });
          return;
        }
        this.#composerChanged(frame.threadId, result.state, projectId);
        send(conn.socket, { kind: "ack", id: frame.id, events: [] });
        return;
      }

      case "presence": {
        if (!(await this.#mayOpenProject(conn, frame.projectId))) {
          send(conn.socket, { kind: "error", id: frame.id, code: "forbidden", message: "not your project" });
          return;
        }
        const profile = frame.location === null ? null : await this.#profile(conn.principal.userId);
        const viewers = this.options.presence.set(
          frame.projectId,
          conn.id,
          frame.location === null
            ? null
            : {
                userId: conn.principal.userId,
                ...(profile ? { name: profile.name, avatarUrl: profile.avatarUrl } : {}),
                clientId: conn.clientId,
                location: frame.location,
                editing: frame.editing ?? false,
              },
        );
        if (viewers) {
          this.#publish(frame.projectId, { type: "presence.changed", projectId: frame.projectId, viewers });
        }
        send(conn.socket, { kind: "ack", id: frame.id, events: [] });
        return;
      }

      case "unsubscribe": {
        this.#end(conn, frame.id);
        send(conn.socket, { kind: "ack", id: frame.id, events: [] });
        return;
      }

      case "terminal_input":
      case "terminal_resize":
        this.#onTerminal(conn, frame);
        return;
    }
  }

  /**
   * A keystroke or a resize, straight to the terminal: not through the
   * engine's queue, behind every other user's commands, and with no ack.
   * The scope is the one `dispatch terminal.input` needs; the reactor checks
   * the terminal is the caller's.
   */
  #onTerminal(conn: Connection, frame: TerminalFrame): void {
    const terminals = this.options.terminals;
    if (!terminals || !hasScope(conn.principal.scopes, REQUIRED_SCOPE["terminal.input"])) {
      this.#refuseTerminal(conn, "forbidden", "not allowed to use a terminal");
      return;
    }
    const userId = conn.principal.userId;
    const delivered =
      frame.kind === "terminal_input"
        ? terminals.input(frame.terminalId, userId, frame.data)
        : terminals.resize(frame.terminalId, userId, frame.cols, frame.rows);
    if (!delivered) this.#refuseTerminal(conn, "not_found", "no such terminal");
  }

  /**
   * Says a terminal frame went nowhere -- once in a while, not once a
   * keystroke: someone typing into a shell that has exited would otherwise
   * get an error back for every key.
   */
  #refuseTerminal(conn: Connection, code: "invalid" | "forbidden" | "not_found", message: string): void {
    const now = Date.now();
    if (now - conn.terminalRefusedAt < TERMINAL_REFUSAL_MS) return;
    conn.terminalRefusedAt = now;
    send(conn.socket, { kind: "error", id: null, code, message });
  }

  /**
   * Tells the thread's watchers what its prompt box now holds. With `only`,
   * to that one socket -- the tab whose update was refused, which is the
   * only one that does not already have it.
   */
  #composerChanged(threadId: string, state: ComposerState, projectId?: string, only?: Connection): void {
    void (async () => {
      const project = projectId ?? (await this.#threadProject(threadId));
      if (!project) return;
      const event = composerEvent(project, threadId, state);
      if (only) {
        // Its own copy, outside any subscription id: the client routes
        // pushes by event, not by which subscription carried them.
        send(only.socket, { kind: "push", subscriptionId: "", seq: null, event });
        return;
      }
      this.#publishToThread(project, threadId, event);
    })();
  }

  /** Profiles change rarely and presence is sent on every move: kept a minute. */
  #profiles = new Map<string, { at: number; value: { name: string; avatarUrl: string | null } | null }>();
  async #profile(userId: string): Promise<{ name: string; avatarUrl: string | null } | null> {
    if (!this.options.profileOf) return null;
    const cached = this.#profiles.get(userId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = await this.options.profileOf(userId).catch(() => null);
    this.#profiles.set(userId, { at: Date.now(), value });
    return value;
  }

  async #mayOpenProject(conn: Connection, projectId: string): Promise<boolean> {
    if (conn.projects.has(projectId)) return true;
    const allowed = await this.options.access.canAccessProject(conn.principal.userId, projectId);
    if (allowed) conn.projects.add(projectId);
    return allowed;
  }

  /** The thread's project, if this socket's user may open it. */
  /**
   * A thread's history as `replay` frames of at most `REPLAY_FRAME_BYTES`,
   * put together from the payloads as the database prints them: no event is
   * parsed or serialized on the way. Stops early if the subscription or the
   * socket goes while it waits for the socket to drain. Returns the
   * sequence numbers it sent.
   */
  async #replayBatched(conn: Connection, subscriptionId: string, threadId: string, sinceSeq: number): Promise<Set<number>> {
    const history = await this.store.readThreadRaw(threadId, sinceSeq, REPLAY_LIMIT);
    const seen = new Set<number>();
    const head = `{"kind":"replay","subscriptionId":${JSON.stringify(subscriptionId)},"events":[`;
    // What a frame holds besides its events: the head, and `],"done":false}`.
    const room = REPLAY_FRAME_BYTES - Buffer.byteLength(head) - 16;
    let entries: string[] = [];
    let bytes = 0;
    const flush = (done: boolean) => {
      const data = `${head}${entries.join(",")}],"done":${done}}`;
      entries = [];
      bytes = 0;
      if (sendRaw(conn.socket, data)) countOut("replay", "", data);
    };
    for (const row of history) {
      // The fields in the order of `ServerFrame`'s replay entries.
      const entry = `{"seq":${row.seq},"at":"${row.createdAt}","projectId":"${row.projectId}","event":${row.payload}}`;
      const size = Buffer.byteLength(entry) + 1;
      if (entries.length > 0 && bytes + size > room) {
        flush(false);
        if (!(await drained(conn.socket)) || !conn.subscriptions.has(subscriptionId)) return seen;
      }
      entries.push(entry);
      bytes += size;
      seen.add(row.seq);
    }
    if (entries.length > 0) flush(true);
    return seen;
  }

  /** The replay for a client without `replay1`: one push per event. */
  async #replayEach(conn: Connection, subscriptionId: string, threadId: string, sinceSeq: number): Promise<Set<number>> {
    const history = await this.store.readThread(threadId, sinceSeq, { limit: REPLAY_LIMIT });
    for (const stored of history) {
      send(conn.socket, {
        kind: "push",
        subscriptionId,
        seq: stored.seq,
        at: stored.createdAt,
        projectId: stored.projectId,
        event: stored.event,
      });
    }
    return new Set(history.map((h) => h.seq));
  }

  async #mayOpenThread(conn: Connection, threadId: string): Promise<string | null> {
    const known = conn.threads.get(threadId);
    if (known) return known;
    const projectId = await this.options.access.threadProject(conn.principal.userId, threadId);
    if (projectId) conn.threads.set(threadId, projectId);
    return projectId;
  }

  async #threadProject(threadId: string): Promise<string | null> {
    return this.options.access.projectOfThread(threadId);
  }

  #publish(projectId: string, event: DomainEvent): void {
    this.bus.publish({ seq: null, projectId, threadId: null, event });
  }

  #publishToThread(projectId: string, threadId: string, event: DomainEvent): void {
    this.bus.publish({ seq: null, projectId, threadId, event });
  }

  /** Ends one subscription of a socket, and everything kept about it. */
  #end(conn: Connection, subscriptionId: string): void {
    conn.subscriptions.get(subscriptionId)?.();
    conn.subscriptions.delete(subscriptionId);
    conn.subscriptionKinds.delete(subscriptionId);
    conn.subscriptionProjects.delete(subscriptionId);
    conn.subscriptionWorkspaces.delete(subscriptionId);
    const watched = conn.watching.get(subscriptionId);
    if (watched) {
      conn.watching.delete(subscriptionId);
      this.options.onProjectWatch?.(watched, -1);
    }
  }

  /**
   * Re-checks what open sockets may watch, after access changed: a member
   * removed or demoted (`userId`), a project deleted (`projectId`). What is
   * no longer allowed is unsubscribed on the spot and the client told, rather
   * than left streaming until the next reconnect.
   */
  async revalidate(match: { userId?: string; projectId?: string }): Promise<void> {
    for (const conn of this.#connections) {
      if (match.userId && conn.principal.userId !== match.userId) continue;
      if (match.projectId) {
        conn.projects.delete(match.projectId);
        for (const [thread, project] of conn.threads) if (project === match.projectId) conn.threads.delete(thread);
      } else {
        conn.projects.clear();
        conn.threads.clear();
      }
      const verdicts = new Map<string, Promise<boolean>>();
      for (const [subscriptionId, projectId] of conn.subscriptionProjects) {
        if (match.projectId && projectId !== match.projectId) continue;
        let verdict = verdicts.get(projectId);
        if (!verdict) {
          verdict = this.options.access.canAccessProject(conn.principal.userId, projectId);
          verdicts.set(projectId, verdict);
        }
        if (await verdict) continue;
        this.#end(conn, subscriptionId);
        send(conn.socket, { kind: "revoked", subscriptionId });
      }
      if (match.projectId || !this.options.access.canAccessWorkspace) continue;
      for (const [subscriptionId, workspaceId] of conn.subscriptionWorkspaces) {
        if (await this.options.access.canAccessWorkspace(conn.principal.userId, workspaceId)) continue;
        this.#end(conn, subscriptionId);
        send(conn.socket, { kind: "revoked", subscriptionId });
      }
    }
  }

  /** Closes every socket a signed-out session opened. */
  closeSession(sessionId: string): void {
    for (const conn of this.#connections) {
      if (conn.principal.sessionId === sessionId) conn.socket.close(4001, "signed out");
    }
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Open subscriptions across every socket, by topic kind. */
  subscriptionCounts(): Map<Topic["name"], number> {
    const counts = new Map<Topic["name"], number>();
    for (const conn of this.#connections) {
      for (const kind of conn.subscriptionKinds.values()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
  }

  close(): void {
    for (const conn of this.#connections) conn.socket.close();
    this.#wss.close();
  }
}

/**
 * A terminal frame read with `typeof` checks rather than the schema, to the
 * same rules (see `TerminalInputFrame` in the protocol). Null when it is not
 * one.
 */
export function terminalFrame(raw: string): TerminalFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  const { terminalId } = frame;
  if (typeof terminalId !== "string" || terminalId.length > 64) return null;
  if (frame.kind === "terminal_input") {
    const { data } = frame;
    if (typeof data !== "string" || data.length > TERMINAL_INPUT_MAX) return null;
    return { kind: "terminal_input", terminalId, data };
  }
  if (frame.kind === "terminal_resize") {
    const { cols, rows } = frame;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return null;
    return { kind: "terminal_resize", terminalId, cols, rows };
  }
  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function composerEvent(projectId: string, threadId: string, state: ComposerState): DomainEvent {
  return {
    type: "composer.changed",
    projectId,
    threadId,
    rev: state.rev,
    draft: state.draft,
    origin: state.origin,
  };
}

/**
 * Bytes a socket may have queued before it is dropped.
 *
 * A client that stops reading -- a backgrounded tab, a dead network that has
 * not timed out yet -- otherwise makes the server hold every token and every
 * line of terminal output for it in memory. Closing it is safe: the client
 * reconnects and resumes from the last `seq` it saw.
 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

const framesIn = registry.counter("ws_frames_in_total", "Frames received from clients, by kind", ["kind"]);
const framesOut = registry.counter(
  "ws_frames_out_total",
  "Frames sent to clients, by kind and, for pushes, event type",
  ["kind", "event"],
);
const bytesOut = registry.counter("ws_bytes_out_total", "Bytes sent to clients, by frame kind", ["kind"]);

function send(socket: WebSocket, frame: ServerFrame): void {
  const data = JSON.stringify(frame);
  if (sendRaw(socket, data)) countOut(frame.kind, frame.kind === "push" ? frame.event.type : "", data);
}

/** True when the frame was handed to the socket. */
function sendRaw(socket: WebSocket, data: string): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return false;
  }
  socket.send(data);
  return true;
}

/** Waits for the socket to hold at most `REPLAY_DRAIN_BYTES` unsent; false once it has closed. */
async function drained(socket: WebSocket): Promise<boolean> {
  while (socket.readyState === socket.OPEN && socket.bufferedAmount > REPLAY_DRAIN_BYTES) {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_DRAIN_POLL_MS));
  }
  return socket.readyState === socket.OPEN;
}

function countOut(kind: string, event: string, data: string): void {
  framesOut.inc({ kind, event });
  bytesOut.inc({ kind }, Buffer.byteLength(data));
}

/**
 * Each event serialized once, however many subscriptions it reaches.
 *
 * One streamed token is published to its thread and its project, and every
 * open tab has a subscription on each: serializing per subscriber was the
 * same `JSON.stringify` of the same event, many times a token.
 */
const serializedEvents = new WeakMap<object, string>();

function sendPush(
  socket: WebSocket,
  subscriptionId: string,
  publication: { seq?: number | null; projectId?: string | null; event: DomainEvent },
): void {
  if (socket.readyState !== socket.OPEN) return;
  let event = serializedEvents.get(publication.event);
  if (event === undefined) {
    event = JSON.stringify(publication.event);
    serializedEvents.set(publication.event, event);
  }
  // Built by hand only around the cached event, and with the same fields in
  // the same order as the `ServerFrame` push it stands in for.
  const head = JSON.stringify({
    kind: "push",
    subscriptionId,
    seq: publication.seq,
    at: new Date().toISOString(),
    ...(publication.projectId ? { projectId: publication.projectId } : {}),
  });
  const data = `${head.slice(0, -1)},"event":${event}}`;
  if (sendRaw(socket, data)) countOut("push", publication.event.type, data);
}
