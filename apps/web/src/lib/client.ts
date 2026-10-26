"use client";

import {
  REPLAY_CAP,
  TERMINAL_INPUT_MAX,
  type ClientFrame,
  type Command,
  type ComposerDraft,
  type DomainEvent,
  type Scope,
  type ServerFrame,
  type StoredEvent,
} from "@ucch/protocol";
import { frameBatcher } from "./next-frame";
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
  "project.activity",
  "audit.recorded",
  "resource.changed",
  // A terminal's bytes: read straight off `onEvent` by the terminal views. In
  // the history they evicted the conversation and copied the array per chunk.
  "terminal.output",
  // A turn's tokens, likewise: the chat folds them into runs of its own
  // (`thread-store.ts`), and as rows here a long answer pushed the rest of
  // the conversation out of the window.
  "agent.text_delta",
  "agent.thinking_delta",
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
   * What each topic is subscribed for, by `topicKey`: `pinned` by
   * `subscribe` until `unsubscribe`, and the views holding it (`hold`) until
   * each lets go. The subscription is what all of them together ask for.
   */
  #wanted = new Map<string, { pinned: SubscribeTopic | null; holds: Set<Hold> }>();
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
  /** Change listeners hear once a frame, however many frames arrived in it. */
  #emitter = frameBatcher(() => {
    for (const listener of this.#listeners) listener();
  });

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

  /**
   * Keystrokes into a terminal: sent and forgotten, with no ack to wait for
   * and nothing to settle. A paste longer than one frame carries is sent in
   * pieces, never splitting a character in two. Dropped when the socket is
   * not open, as a `dispatch` would be refused.
   */
  terminalInput(terminalId: string, data: string): void {
    for (const piece of terminalPieces(data)) this.#send({ kind: "terminal_input", terminalId, data: piece });
  }

  /** A terminal's new size, the same way as `terminalInput`. */
  terminalResize(terminalId: string, cols: number, rows: number): void {
    this.#send({ kind: "terminal_resize", terminalId, cols, rows });
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

    const socket = new WebSocket(`${websocketOrigin()}/ws?ticket=${ticket}&client=${TAB_ID}&caps=${REPLAY_CAP}`);
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

  /**
   * Subscribes to a topic for as long as the tab is open, or until
   * `unsubscribe`. Resolves once the server has answered -- after the
   * replay, for a thread -- or at once when the socket is not open yet.
   */
  subscribe(topic: SubscribeTopic): Promise<void> {
    const wanted = this.#wantedFor(topic);
    wanted.pinned = wanted.pinned ? mergeTopic(wanted.pinned, topic) : topic;
    return this.#sync(topicKey(topic));
  }

  /**
   * Subscribes to a topic for one view, until it calls `release`.
   *
   * Counted: the subscription ends when the last view lets go of it and
   * nothing `subscribe`d it, and one that asked for more than the rest --
   * loud, or files -- goes back to what the others ask for. `onEvent` hears
   * every event of the subscription, the ones this client heard before
   * included: a thread's replay lands in it however many views already
   * had the thread open, since holding a thread with `onEvent` asks for
   * the replay again. `ready` is `subscribe`'s promise.
   */
  hold(topic: SubscribeTopic, onEvent?: (row: ClientEvent) => void): { ready: Promise<void>; release(): void } {
    const key = topicKey(topic);
    const hold: Hold = { topic, ...(onEvent ? { onEvent } : {}) };
    this.#wantedFor(topic).holds.add(hold);
    const ready = this.#sync(key, topic.name === "thread" && onEvent !== undefined);
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.#wanted.get(key)?.holds.delete(hold);
        void this.#sync(key).catch(() => {});
      },
    };
  }

  /**
   * Keeps the server's file watcher on a project running for as long as a
   * view showing its files is mounted: changes made on disk outside the
   * server -- a terminal, a dev server, git -- then arrive as
   * `file.changed`. The watcher goes off when the last such view calls the
   * returned function, and the project's subscription stays, as quiet as it
   * was. `tree` is a session's hash, to watch its worktree rather than the
   * project's checkout.
   */
  holdFiles(projectId: string, tree?: string | null): () => void {
    const held = this.hold({ name: "project", projectId, quiet: true, files: true, ...(tree ? { tree } : {}) });
    held.ready.catch(() => {});
    return held.release;
  }

  /** Stops listening to a topic -- a terminal tab closed -- whoever asked for it. Idempotent. */
  unsubscribe(topic: SubscribeTopic): void {
    const key = topicKey(topic);
    this.#wanted.delete(key);
    void this.#sync(key).catch(() => {});
  }

  #wantedFor(topic: SubscribeTopic): { pinned: SubscribeTopic | null; holds: Set<Hold> } {
    const key = topicKey(topic);
    let wanted = this.#wanted.get(key);
    if (!wanted) this.#wanted.set(key, (wanted = { pinned: null, holds: new Set() }));
    return wanted;
  }

  /**
   * Brings the server's subscription to a topic in line with what is wanted
   * of it: none, or one that gives everyone what they asked for. A change is
   * an unsubscribe and a new subscription; `replay` makes one even when
   * nothing changed, so the server replays the thread again.
   */
  async #sync(key: string, replay = false): Promise<void> {
    const wanted = this.#wanted.get(key);
    const topics = wanted ? [...(wanted.pinned ? [wanted.pinned] : []), ...[...wanted.holds].map((h) => h.topic)] : [];
    if (wanted && topics.length === 0) this.#wanted.delete(key);
    const topic = topics.length > 0 ? topics.reduce(mergeTopic) : null;

    let lastSeq = -1;
    for (const [existingId, existing] of this.#subscriptions) {
      if (topicKey(existing.topic) !== key) continue;
      if (topic && !replay && sameTopic(existing.topic, topic)) return;
      // A replay asked for is the whole of it, even if it waits for a reconnect.
      lastSeq = replay ? -1 : existing.lastSeq;
      this.#subscriptions.delete(existingId);
      this.#send({ kind: "unsubscribe", id: existingId });
    }
    if (!topic) return;

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

  /** Hands a subscription's events to the views holding it with `onEvent`. */
  #toHolds(subscriptionId: string, rows: readonly ClientEvent[]): void {
    const sub = this.#subscriptions.get(subscriptionId);
    const holds = sub && this.#wanted.get(topicKey(sub.topic))?.holds;
    if (!holds) return;
    for (const hold of holds) {
      if (!hold.onEvent) continue;
      for (const row of rows) {
        try {
          hold.onEvent(row);
        } catch {
          // One broken view must not stop the others hearing.
        }
      }
    }
  }

  #onFrame(raw: string): void {
    const frame = parseServerFrame(raw);
    if (!frame) return;

    switch (frame.kind) {
      case "ready": {
        outdatedBuild(frame.buildId);
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
        const row = toRow(frame.seq, frame.event, frame.at ? Date.parse(frame.at) : Date.now(), frame.projectId);
        this.#toHolds(frame.subscriptionId, [row]);
        if (this.#take(row)) this.#keep([row]);
        break;
      }

      case "replay": {
        // A thread's history, many events at once: recorded together, so
        // the history is copied once for the lot rather than once an event.
        const sub = this.#subscriptions.get(frame.subscriptionId);
        const rows = frame.events.map((stored) => {
          if (sub && stored.seq > sub.lastSeq) sub.lastSeq = stored.seq;
          return toRow(stored.seq, stored.event, Date.parse(stored.at), stored.projectId);
        });
        this.#toHolds(frame.subscriptionId, rows);
        this.#keep(rows.filter((row) => this.#take(row)));
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
    const row = toRow(seq, event, at, projectId);
    if (this.#take(row)) this.#keep([row]);
  }

  /** Tells the event listeners of an event not heard before; whether it goes in the history. */
  #take(row: ClientEvent): boolean {
    const { seq, event } = row;
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
      if (this.#seen.has(key)) return false;
      this.#seen.add(key);
    }

    for (const listener of this.#eventListeners) {
      try {
        listener(row);
      } catch {
        // One broken view must not stop the others hearing.
      }
    }
    return !EPHEMERAL.has(event.type);
  }

  #keep(rows: readonly ClientEvent[]): void {
    if (rows.length === 0) return;
    this.#events = [...this.#events, ...rows].slice(-500);
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
    this.#emitter.schedule();
  }
}

/**
 * A server frame, or null for one this client cannot read.
 *
 * Not the schema: `ServerFrame.parse` on every frame was most of the
 * client's time while an answer streamed. The fields this file reads are
 * checked instead -- the server is the one that wrote the frame, and it
 * built it from the same types. In development the schema still runs,
 * after the fact, and says when the two disagree.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.kind !== "string") return null;
  const ok = (() => {
    switch (data.kind) {
      case "push":
        return (
          typeof data.subscriptionId === "string" &&
          (data.seq === null || typeof data.seq === "number") &&
          isEvent(data.event)
        );
      case "replay":
        return (
          typeof data.subscriptionId === "string" &&
          Array.isArray(data.events) &&
          data.events.every((row) => isRecord(row) && typeof row.seq === "number" && isEvent(row.event))
        );
      case "ack":
        return (
          typeof data.id === "string" &&
          Array.isArray(data.events) &&
          data.events.every((row) => isRecord(row) && typeof row.seq === "number" && isEvent(row.event))
        );
      case "error":
        return typeof data.code === "string" && typeof data.message === "string";
      case "ready":
        return typeof data.userId === "string" && Array.isArray(data.scopes);
      case "revoked":
        return typeof data.subscriptionId === "string";
      case "pong":
        return true;
      default:
        return false;
    }
  })();
  if (!ok) return null;
  if (process.env.NODE_ENV === "development") {
    void import("@ucch/protocol").then(({ ServerFrame: schema }) => {
      const checked = schema.safeParse(data);
      if (!checked.success) console.warn("[ucch] a server frame does not match the protocol", data, checked.error.issues);
    });
  }
  return data as ServerFrame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string";
}

/**
 * Whether this tab runs another build than the server, and if so, what to
 * do. The update prompt (W5) is not built yet, so a tab found out of date
 * reloads -- once per build, and only while it is hidden, so nothing being
 * typed is lost to it. Without a build id on both sides (development, an
 * image built without one) there is nothing to compare.
 */
function outdatedBuild(serverBuild: string | undefined): void {
  const running = process.env.NEXT_PUBLIC_BUILD_ID;
  if (!running || !serverBuild || serverBuild === running || typeof document === "undefined") return;
  const key = `ucch:reloaded-for:${serverBuild}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch {
    return;
  }
  const reload = () => {
    if (document.visibilityState !== "hidden") return;
    document.removeEventListener("visibilitychange", reload);
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      return;
    }
    location.reload();
  };
  document.addEventListener("visibilitychange", reload);
  reload();
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

/**
 * Terminal input in pieces of at most `TERMINAL_INPUT_MAX`, each ending on a
 * whole character: a cut between the two halves of a surrogate pair would
 * reach the shell as two broken ones.
 */
export function terminalPieces(data: string, max = TERMINAL_INPUT_MAX): string[] {
  if (data.length <= max) return [data];
  const pieces: string[] = [];
  for (let at = 0; at < data.length; ) {
    let end = Math.min(data.length, at + max);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(data.slice(at, end));
    at = end;
  }
  return pieces;
}

/** One view's claim on a topic; see `UcchClient.hold`. */
interface Hold {
  topic: SubscribeTopic;
  onEvent?: (row: ClientEvent) => void;
}

function toRow(seq: number | null, event: DomainEvent, at: number, projectId?: string): ClientEvent {
  return {
    seq,
    event,
    receivedAt: Number.isFinite(at) ? at : Date.now(),
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * One subscription that gives both views what they asked for: loud if
 * either is, watching files if either does. Only project topics differ.
 * One tree is watched per project; views that disagree -- rare, since a
 * page shows one session -- get the latest one's.
 */
function mergeTopic(existing: SubscribeTopic, wanted: SubscribeTopic): SubscribeTopic {
  if (existing.name !== "project" || wanted.name !== "project") return existing;
  const quiet = existing.quiet === true && wanted.quiet === true;
  const files = existing.files === true || wanted.files === true;
  const tree = wanted.files === true ? wanted.tree : existing.tree;
  return {
    name: "project",
    projectId: existing.projectId,
    ...(quiet ? { quiet } : {}),
    ...(files ? { files } : {}),
    ...(files && tree ? { tree } : {}),
  };
}

function sameTopic(a: SubscribeTopic, b: SubscribeTopic): boolean {
  if (a.name !== "project" || b.name !== "project") return topicKey(a) === topicKey(b);
  return (
    a.projectId === b.projectId &&
    (a.quiet === true) === (b.quiet === true) &&
    (a.files === true) === (b.files === true) &&
    (a.tree ?? null) === (b.tree ?? null)
  );
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
  | { name: "project"; projectId: string; quiet?: boolean; files?: boolean; tree?: string }
  | { name: "terminal"; terminalId: string }
  | { name: "user" }
  | { name: "workspace"; workspaceId: string };
