import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientFrame,
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
import type { PresenceStore } from "./presence.js";

const SERVER_VERSION = "0.1.0";
const HEARTBEAT_MS = 30_000;

interface Connection {
  /** This socket, for presence: one person in two windows is two viewers. */
  id: string;
  socket: WebSocket;
  principal: Principal;
  /** The tab's own id, from the upgrade URL; stamped on what it changes. */
  clientId: string;
  subscriptions: Map<string, () => void>;
  alive: boolean;
  /**
   * What this socket has already been allowed to open, so the prompt box,
   * sent on every pause in typing, is not a database round trip each time.
   * Thread id -> its project.
   */
  threads: Map<string, string>;
  projects: Set<string>;
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
  access: Pick<ProjectAccess, "canAccessProject" | "threadProject" | "projectOfThread">;
  composer: ComposerStore;
  presence: PresenceStore;
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
    this.#wss = new WebSocketServer({ noServer: true });

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
    this.#wss.handleUpgrade(request, socket as never, head, (ws) => {
      this.#accept(ws, principal, clientId);
    });
  }

  #accept(socket: WebSocket, principal: Principal, clientId: string): void {
    const conn: Connection = {
      id: randomUUID(),
      socket,
      principal,
      clientId,
      subscriptions: new Map(),
      alive: true,
      threads: new Map(),
      projects: new Set(),
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
    });

    socket.on("message", (raw) => {
      void this.#onMessage(conn, raw.toString());
    });

    socket.on("close", () => {
      for (const unsubscribe of conn.subscriptions.values()) unsubscribe();
      conn.subscriptions.clear();
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
    let frame: ClientFrame;
    try {
      frame = ClientFrame.parse(JSON.parse(raw));
    } catch (error) {
      send(conn.socket, {
        kind: "error",
        id: null,
        code: "invalid",
        message: error instanceof Error ? error.message : "malformed frame",
      });
      return;
    }

    switch (frame.kind) {
      case "ping":
        send(conn.socket, { kind: "pong", id: frame.id, serverTime: new Date().toISOString() });
        return;

      case "dispatch": {
        const result = await this.engine.dispatch(conn.principal, frame.command);
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
        const subscriptionId = randomUUID();

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
        } else {
          // A terminal id is minted by the tab that opens it and never
          // listed anywhere; the session itself refuses input from others.
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
          send(conn.socket, {
            kind: "push",
            subscriptionId,
            seq: publication.seq,
            at: new Date().toISOString(),
            event: publication.event,
          });
        });

        conn.subscriptions.set(subscriptionId, unsubscribe);

        if (frame.topic.name === "thread") {
          const history = await this.store.readThread(frame.topic.threadId, frame.sinceSeq ?? -1);
          for (const stored of history) {
            send(conn.socket, {
              kind: "push",
              subscriptionId,
              seq: stored.seq,
              at: stored.createdAt,
              event: stored.event,
            });
          }
          const seen = new Set(history.map((h) => h.seq));
          for (const stored of buffered) {
            if (stored.seq >= 0 && seen.has(stored.seq)) continue;
            send(conn.socket, {
              kind: "push",
              subscriptionId,
              seq: stored.seq < 0 ? null : stored.seq,
              at: stored.createdAt,
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
        const viewers = this.options.presence.set(
          frame.projectId,
          conn.id,
          frame.location === null
            ? null
            : {
                userId: conn.principal.userId,
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
        const unsubscribe = conn.subscriptions.get(frame.id);
        if (unsubscribe) {
          unsubscribe();
          conn.subscriptions.delete(frame.id);
        }
        send(conn.socket, { kind: "ack", id: frame.id, events: [] });
        return;
      }
    }
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

  async #mayOpenProject(conn: Connection, projectId: string): Promise<boolean> {
    if (conn.projects.has(projectId)) return true;
    const allowed = await this.options.access.canAccessProject(conn.principal.userId, projectId);
    if (allowed) conn.projects.add(projectId);
    return allowed;
  }

  /** The thread's project, if this socket's user may open it. */
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

  get connectionCount(): number {
    return this.#connections.size;
  }

  close(): void {
    for (const conn of this.#connections) conn.socket.close();
    this.#wss.close();
  }
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

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
