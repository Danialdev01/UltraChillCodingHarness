"use client";

import {
  ServerFrame,
  type ClientFrame,
  type Command,
  type DomainEvent,
  type Scope,
  type StoredEvent,
} from "@ucch/protocol";

export type ConnectionState = "idle" | "connecting" | "ready" | "reconnecting" | "failed";

export interface ClientEvent {
  seq: number | null;
  event: DomainEvent;
  /**
   * When the event happened, as a Unix time in ms. The server's clock, from
   * the frame -- so a replayed event is dated to when it was recorded, not
   * to the reload that fetched it.
   */
  receivedAt: number;
}

type Listener = () => void;

/**
 * The client half of the wire contract.
 *
 * All state lives on the server; this holds no independent model of the world,
 * only what the server has told it. Reconnection is automatic and resubscribes
 * from the last sequence number seen, so a dropped connection replays the gap
 * instead of losing it.
 */
export class UcchClient {
  #socket: WebSocket | null = null;
  #state: ConnectionState = "idle";
  #userId: string | null = null;
  #scopes: Scope[] = [];
  #events: ClientEvent[] = [];
  #listeners = new Set<Listener>();
  #pending = new Map<string, { resolve: (v: StoredEvent[]) => void; reject: (e: Error) => void }>();
  #subscriptions = new Map<string, { topic: SubscribeTopic; lastSeq: number }>();
  /**
   * Durable events already recorded, keyed by scope and sequence.
   *
   * The same event arrives twice by design: once as the ack to the command
   * that caused it, and again as a push to whoever is subscribed to its
   * topic. Both paths matter -- a client that never subscribed still needs
   * the ack -- so the duplicate is resolved here rather than by dropping one.
   */
  #seen = new Set<string>();
  #attempt = 0;
  #closed = false;
  #nextId = 0;

  get state(): ConnectionState {
    return this.#state;
  }
  get userId(): string | null {
    return this.#userId;
  }
  get scopes(): readonly Scope[] {
    return this.#scopes;
  }
  get events(): readonly ClientEvent[] {
    return this.#events;
  }

  subscribeToChanges(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.#state === "connecting" || this.#state === "ready") return;
    this.#closed = false;
    this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");

    let ticket: string;
    try {
      const response = await fetch("/api/ws-ticket", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
      ticket = ((await response.json()) as { ticket: string }).ticket;
    } catch {
      this.#scheduleReconnect();
      return;
    }

    // `close()` may have been called while the ticket was in flight -- an
    // unmount during connect is the common case, not a rare one. Without this
    // the socket opens anyway and lives on unreferenced, holding a
    // subscription nothing will ever read.
    if (this.#closed) return;

    const socket = new WebSocket(`${websocketOrigin()}/ws?ticket=${ticket}`);
    this.#socket = socket;

    socket.onmessage = (message) => this.#onFrame(String(message.data));
    socket.onclose = () => {
      this.#socket = null;
      // Reject in-flight commands rather than leaving callers hanging on a
      // promise that can no longer be answered.
      for (const [, p] of this.#pending) p.reject(new Error("connection closed"));
      this.#pending.clear();
      if (!this.#closed) this.#scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  /**
   * Resolves once the socket has authenticated and can carry a command.
   *
   * `connect()` returns as soon as the socket exists, which is before it
   * opens; a `dispatch` in between is rejected as not connected. Callers that
   * need to send something right after connecting wait here first.
   */
  whenReady(timeoutMs = 10_000): Promise<void> {
    if (this.#state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("could not reach the server"));
      }, timeoutMs);
      const unsubscribe = this.subscribeToChanges(() => {
        if (this.#state === "failed") {
          clearTimeout(timer);
          unsubscribe();
          reject(new Error("could not reach the server"));
          return;
        }
        if (this.#state !== "ready") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#setState("idle");
  }

  /** Sends a command and resolves with the events it produced. */
  dispatch(command: Command): Promise<StoredEvent[]> {
    return new Promise((resolve, reject) => {
      const id = String(this.#nextId++);
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      this.#send({ kind: "dispatch", id, command });
    });
  }

  async subscribe(topic: SubscribeTopic): Promise<void> {
    // Subscribing to the same topic twice would have the server push every
    // event to this socket once per registration.
    const key = topicKey(topic);
    for (const [, existing] of this.#subscriptions) {
      if (topicKey(existing.topic) === key) return;
    }

    const id = String(this.#nextId++);
    this.#subscriptions.set(id, { topic, lastSeq: -1 });

    // `connect()` returns once the socket exists, which is before it opens, so
    // this is the common case rather than the exceptional one. Registering the
    // topic is the whole job: the `ready` handler replays every registered
    // subscription. Waiting on an ack here would mean waiting on a frame that
    // `#send` had already dropped for not being open yet -- a promise nothing
    // could ever answer, left to be rejected on teardown.
    if (this.#socket?.readyState !== WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve: () => resolve(), reject });
      this.#send({ kind: "subscribe", id, topic });
    });
  }

  #onFrame(raw: string): void {
    let frame;
    try {
      frame = ServerFrame.parse(JSON.parse(raw));
    } catch {
      return;
    }

    switch (frame.kind) {
      case "ready":
        this.#attempt = 0;
        this.#userId = frame.userId;
        this.#scopes = frame.scopes;
        this.#setState("ready");
        // Re-establish subscriptions from where each one left off, so the
        // gap created by the disconnect is replayed rather than lost.
        for (const [, sub] of this.#subscriptions) {
          const id = String(this.#nextId++);
          this.#send({
            kind: "subscribe",
            id,
            topic: sub.topic,
            ...(sub.lastSeq >= 0 ? { sinceSeq: sub.lastSeq } : {}),
          });
        }
        break;

      case "ack": {
        this.#pending.get(frame.id)?.resolve(frame.events);
        this.#pending.delete(frame.id);
        for (const stored of frame.events)
          this.#record(stored.seq, stored.event, Date.parse(stored.createdAt));
        break;
      }

      case "error": {
        if (frame.id) {
          this.#pending.get(frame.id)?.reject(new Error(`${frame.code}: ${frame.message}`));
          this.#pending.delete(frame.id);
        }
        break;
      }

      case "push": {
        const sub = this.#subscriptions.get(frame.subscriptionId);
        if (sub && frame.seq !== null && frame.seq > sub.lastSeq) sub.lastSeq = frame.seq;
        this.#record(frame.seq, frame.event, frame.at ? Date.parse(frame.at) : Date.now());
        break;
      }

      case "pong":
        break;
    }
  }

  /**
   * `at` is when the event happened, by the server's clock -- which for a
   * replayed event is long before now. Falls back to now for a frame without
   * one, so an older server still dates live events well enough.
   */
  #record(seq: number | null, event: DomainEvent, at: number = Date.now()): void {
    // (scope, seq) is what the server's unique index enforces, so it is what
    // identifies an event here too. Transient events carry no sequence and
    // arrive only once, by push.
    if (seq !== null) {
      const scope =
        "threadId" in event && event.threadId
          ? `t:${event.threadId}`
          : "projectId" in event && event.projectId
            ? `p:${event.projectId}`
            : "";
      const key = `${scope}:${seq}`;
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
    }

    this.#events = [
      ...this.#events,
      { seq, event, receivedAt: Number.isFinite(at) ? at : Date.now() },
    ].slice(-500);
    this.#emit();
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(frame));
  }

  #scheduleReconnect(): void {
    this.#attempt++;
    if (this.#attempt > 10) {
      this.#setState("failed");
      return;
    }
    this.#setState("reconnecting");
    // Exponential backoff with jitter: without the jitter, every client that
    // dropped together would reconnect together.
    const base = Math.min(1000 * 2 ** (this.#attempt - 1), 30_000);
    const delay = base * (0.5 + Math.random() * 0.5);
    setTimeout(() => void this.connect(), delay);
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * In production the gateway serves the UI and the socket from one origin, so
 * same-origin is correct. In development Next runs on its own port and its
 * rewrites do not proxy WebSocket upgrades, so the server origin is passed in
 * explicitly.
 */
function websocketOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_WS_ORIGIN;
  if (configured) return configured.replace(/^http/, "ws").replace(/\/$/, "");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
}

function topicKey(topic: SubscribeTopic): string {
  switch (topic.name) {
    case "thread":
      return `thread:${topic.threadId}`;
    case "project":
      return `project:${topic.projectId}`;
    case "terminal":
      return `terminal:${topic.terminalId}`;
  }
}

export type SubscribeTopic =
  | { name: "thread"; threadId: string }
  | { name: "project"; projectId: string }
  | { name: "terminal"; terminalId: string };
