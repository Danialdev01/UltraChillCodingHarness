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
    const id = String(this.#nextId++);
    this.#subscriptions.set(id, { topic, lastSeq: -1 });
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
        for (const stored of frame.events) this.#record(stored.seq, stored.event);
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
        this.#record(frame.seq, frame.event);
        break;
      }

      case "pong":
        break;
    }
  }

  #record(seq: number | null, event: DomainEvent): void {
    this.#events = [...this.#events, { seq, event, receivedAt: Date.now() }].slice(-500);
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

export type SubscribeTopic =
  | { name: "thread"; threadId: string }
  | { name: "project"; projectId: string }
  | { name: "terminal"; terminalId: string };
