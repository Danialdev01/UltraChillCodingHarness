"use client";

import {
  ServerFrame,
  type ClientFrame,
  type Command,
  type ComposerDraft,
  type DomainEvent,
  type Scope,
  type StoredEvent,
} from "@ucch/protocol";
import { TAB_ID } from "./tab-id";

/**
 * Live state rather than history: delivered to `onEvent` listeners but kept
 * out of `events`, whose 500-row window is a conversation's history. A prompt
 * box shared keystroke by keystroke would otherwise push the conversation
 * out of it.
 */
const EPHEMERAL: ReadonlySet<DomainEvent["type"]> = new Set([
  "composer.changed",
  "presence.changed",
  "audit.recorded",
  "resource.changed",
  // A terminal's bytes: read straight off `onEvent` by the terminal views. In
  // the history they evicted the conversation and copied the array per chunk.
  "terminal.output",
]);

/** A refusal from the server, with its code -- `conflict` is the one callers branch on. */
export class ServerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
  /**
   * The project the event belongs to, when the server said. A thread's own
   * events name only the thread, so this is how a listener watching several
   * projects at once tells them apart.
   */
  projectId?: string;
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
  #eventListeners = new Set<(event: ClientEvent) => void>();
  /** Where this tab said it was in each project, re-sent after a reconnect. */
  #presence = new Map<string, { location: string | null; editing: boolean }>();
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
  /** Set once the first `ready` arrives: every later one is a reconnect. */
  #everReady = false;
  #reconnectListeners = new Set<() => void>();
  #retry: ReturnType<typeof setTimeout> | null = null;
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

  /**
   * After the socket came back from a drop. Whatever happened meanwhile was
   * not pushed to this tab -- only thread history is replayed -- so a view
   * that shows server data should treat this as "refetch everything".
   */
  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  /** Every event as it arrives, including the live ones `events` does not keep. */
  onEvent(listener: (event: ClientEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Shares what this tab has typed in a thread's prompt box. Rejects with a
   * `ServerError` coded `conflict` when another window wrote first; by then
   * this tab has already been sent what that window wrote.
   */
  updateComposer(threadId: string, baseRev: number, draft: ComposerDraft): Promise<void> {
    return this.#request((id) => ({ kind: "composer", id, threadId, baseRev, draft }));
  }

  /** Where this tab is in a project, or null when it leaves. Kept across reconnects. */
  setPresence(projectId: string, location: string | null, editing = false): void {
    const last = this.#presence.get(projectId);
    if (last && last.location === location && last.editing === editing) return;
    if (location === null) this.#presence.delete(projectId);
    else this.#presence.set(projectId, { location, editing });
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    void this.#request((id) => ({ kind: "presence", id, projectId, location, editing })).catch(() => {});
  }

  #request(frame: (id: string) => ClientFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = String(this.#nextId++);
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
        reject(new ServerError("unavailable", "not connected"));
        return;
      }
      this.#pending.set(id, { resolve: () => resolve(), reject });
      this.#send(frame(id));
    });
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

    const socket = new WebSocket(`${websocketOrigin()}/ws?ticket=${ticket}&client=${TAB_ID}`);
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
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
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
    let lastSeq = -1;
    for (const [existingId, existing] of this.#subscriptions) {
      if (topicKey(existing.topic) !== key) continue;
      // A quiet project subscription leaves out the token and terminal
      // streams. A view that wants them -- asked for the same topic loudly --
      // upgrades it, rather than being silently given the quiet one; one
      // subscription per topic stays the rule.
      const quiet = (t: SubscribeTopic) => t.name === "project" && t.quiet === true;
      if (!quiet(existing.topic) || quiet(topic)) return;
      lastSeq = existing.lastSeq;
      this.#subscriptions.delete(existingId);
      this.#send({ kind: "unsubscribe", id: existingId });
    }

    const id = String(this.#nextId++);
    this.#subscriptions.set(id, { topic, lastSeq });

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

  /** Stops listening to a topic -- a terminal tab closed. Idempotent. */
  unsubscribe(topic: SubscribeTopic): void {
    const key = topicKey(topic);
    for (const [id, existing] of this.#subscriptions) {
      if (topicKey(existing.topic) !== key) continue;
      this.#subscriptions.delete(id);
      this.#send({ kind: "unsubscribe", id });
    }
  }

  #onFrame(raw: string): void {
    let frame;
    try {
      frame = ServerFrame.parse(JSON.parse(raw));
    } catch {
      return;
    }

    switch (frame.kind) {
      case "ready": {
        this.#attempt = 0;
        this.#userId = frame.userId;
        this.#scopes = frame.scopes;
        this.#setState("ready");
        const reconnected = this.#everReady;
        this.#everReady = true;
        // Re-establish subscriptions from where each one left off, so the
        // gap created by the disconnect is replayed rather than lost. Each
        // is re-keyed by its new frame id, which the server's pushes carry.
        for (const [old, sub] of [...this.#subscriptions]) {
          const id = String(this.#nextId++);
          this.#subscriptions.delete(old);
          this.#subscriptions.set(id, sub);
          this.#send({
            kind: "subscribe",
            id,
            topic: sub.topic,
            ...(sub.lastSeq >= 0 ? { sinceSeq: sub.lastSeq } : {}),
          });
        }
        for (const [projectId, place] of this.#presence) {
          this.#send({ kind: "presence", id: String(this.#nextId++), projectId, ...place });
        }
        if (reconnected) {
          for (const listener of this.#reconnectListeners) {
            try {
              listener();
            } catch {
              // One view's resync failing must not stop the others'.
            }
          }
        }
        break;
      }

      case "ack": {
        this.#pending.get(frame.id)?.resolve(frame.events);
        this.#pending.delete(frame.id);
        for (const stored of frame.events)
          this.#record(stored.seq, stored.event, Date.parse(stored.createdAt), stored.projectId);
        break;
      }

      case "error": {
        if (frame.id) {
          this.#pending
            .get(frame.id)
            ?.reject(new ServerError(frame.code, `${frame.code}: ${frame.message}`));
          this.#pending.delete(frame.id);
        }
        break;
      }

      case "push": {
        const sub = this.#subscriptions.get(frame.subscriptionId);
        if (sub && frame.seq !== null && frame.seq > sub.lastSeq) sub.lastSeq = frame.seq;
        this.#record(
          frame.seq,
          frame.event,
          frame.at ? Date.parse(frame.at) : Date.now(),
          frame.projectId,
        );
        break;
      }

      case "revoked":
        // Access to it is gone (removed from the workspace, project deleted):
        // forget it, so a reconnect does not ask again.
        this.#subscriptions.delete(frame.subscriptionId);
        this.#emit();
        break;

      case "pong":
        break;
    }
  }

  /**
   * `at` is when the event happened, by the server's clock -- which for a
   * replayed event is long before now. Falls back to now for a frame without
   * one, so an older server still dates live events well enough.
   */
  #record(
    seq: number | null,
    event: DomainEvent,
    at: number = Date.now(),
    projectId?: string,
  ): void {
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

    const row: ClientEvent = {
      seq,
      event,
      receivedAt: Number.isFinite(at) ? at : Date.now(),
      ...(projectId ? { projectId } : {}),
    };
    for (const listener of this.#eventListeners) {
      try {
        listener(row);
      } catch {
        // One broken view must not stop the others hearing.
      }
    }
    if (EPHEMERAL.has(event.type)) return;
    this.#events = [...this.#events, row].slice(-500);
    this.#emit();
  }

  #send(frame: ClientFrame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(frame));
  }

  #scheduleReconnect(): void {
    this.#attempt++;
    // Past ten tries the state says so (the banner reads it), but trying
    // never stops: a server back after a long deploy should find every open
    // tab again without anyone reloading.
    this.#setState(this.#attempt > 10 ? "failed" : "reconnecting");
    // Exponential backoff with jitter: without the jitter, every client that
    // dropped together would reconnect together.
    const base = Math.min(1000 * 2 ** (this.#attempt - 1), 30_000);
    const delay = base * (0.5 + Math.random() * 0.5);
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      // A hidden tab waits to be looked at rather than knocking every 30 s.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", () => void this.#reconnectNow(), { once: true });
        return;
      }
      void this.connect();
    }, delay);
  }

  /** Coming back to the tab, or the network returning: try at once rather than wait out the backoff. */
  #reconnectNow(): Promise<void> {
    if (this.#closed || this.#state === "ready" || this.#state === "connecting") return Promise.resolve();
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#attempt = Math.max(this.#attempt - 1, 0);
    return this.connect();
  }

  /** For `online` and visibility events from the page. */
  retryNow(): void {
    void this.#reconnectNow();
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
    case "user":
      return "user";
    case "workspace":
      return `workspace:${topic.workspaceId}`;
  }
}

export type SubscribeTopic =
  | { name: "thread"; threadId: string }
  | { name: "project"; projectId: string; quiet?: boolean }
  | { name: "terminal"; terminalId: string }
  | { name: "user" }
  | { name: "workspace"; workspaceId: string };
