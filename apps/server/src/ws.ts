import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientFrame, type ServerFrame, type StoredEvent } from "@ucch/protocol";
import type { AuthService, Principal } from "./auth.js";
import type { EventBus } from "./bus.js";
import type { EventStore } from "./eventstore.js";
import type { OrchestrationEngine } from "./engine.js";

const SERVER_VERSION = "0.1.0";
const HEARTBEAT_MS = 30_000;

interface Connection {
  socket: WebSocket;
  principal: Principal;
  subscriptions: Map<string, () => void>;
  alive: boolean;
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

    this.#wss.handleUpgrade(request, socket as never, head, (ws) => {
      this.#accept(ws, principal);
    });
  }

  #accept(socket: WebSocket, principal: Principal): void {
    const conn: Connection = { socket, principal, subscriptions: new Map(), alive: true };
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
        if (result.ok) {
          send(conn.socket, { kind: "ack", id: frame.id, events: result.events });
        } else {
          send(conn.socket, { kind: "error", id: frame.id, code: result.code, message: result.message });
        }
        return;
      }

      case "subscribe": {
        const subscriptionId = randomUUID();

        // Replay durable history before attaching the live listener, so a
        // resuming client sees a continuous stream with no gap and no
        // duplicate. Events arriving during replay are buffered, not dropped.
        const buffered: StoredEvent[] = [];
        let replaying = true;

        const unsubscribe = this.bus.subscribe(frame.topic, (publication) => {
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
              event: stored.event,
            });
          }
        }

        replaying = false;
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

  get connectionCount(): number {
    return this.#connections.size;
  }

  close(): void {
    for (const conn of this.#connections) conn.socket.close();
    this.#wss.close();
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
