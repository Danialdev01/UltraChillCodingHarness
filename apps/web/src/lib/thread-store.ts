import { THREAD_WINDOW, type DomainEvent } from "@ucch/protocol";
import type { ClientEvent } from "./client";
import { frameBatcher } from "./next-frame";

/**
 * One conversation's events, as the chat draws them.
 *
 * The client's own history is a capped window over everything the socket
 * hears, and a long answer used to stream into it a token at a time: every
 * delta took a row, so the answer pushed the user's own message and the
 * tool calls before it out of the window, and back only on reload. Here the
 * two kinds are kept apart.
 *
 * - **Durable**: the thread's logged events, sorted by sequence, each once
 *   (an event comes as the ack to the command that caused it and again as a
 *   push), and at most `THREAD_WINDOW` of them -- what the server replays.
 * - **Runs**: streamed tokens, and `agent.retry`, which are never logged.
 *   Consecutive deltas of one kind and turn are folded into one run, kept
 *   where it streamed: after the newest durable event at the time. A long
 *   answer is one run, not thousands of rows.
 *
 * Runs outlive their turn: a turn's thinking is never logged, so its run is
 * all there is to show, and an iteration whose `agent.message` came back
 * empty is drawn from what streamed. A run goes when the durable event it
 * follows leaves the window. A turn still open when the socket drops loses
 * its runs (`reset`): what streamed meanwhile is gone, and the logged
 * message replaces the lot once it lands.
 *
 * `rows` is what `toMessages` reads -- the durable events with each run
 * where it streamed, as the interleaved deltas it used to read. Split for
 * the chat, which folds the settled part once and redraws only the turn
 * that is streaming (`overlayLive`): `durable` is that without the runs of
 * turns still open, and `live` is each open turn's own events with its
 * runs. Two versions say what changed: `durableVersion` for the log and
 * for the runs of finished turns, `liveVersion` for the runs of turns still
 * open. Listeners hear at most once a frame.
 *
 * `queued` is how many turns are ahead of the thread's sent message while
 * it waits for the server to have a slot (`agent.queued`), and null once
 * its turn starts or is dropped. Live state too: it changes `liveVersion`.
 */
export class ThreadStore {
  readonly threadId: string;
  #durable: ClientEvent[] = [];
  #seqs = new Set<number>();
  #runs: Run[] = [];
  /** Turns that have ended: their runs no longer change. */
  #ended = new Set<string>();
  #queued: number | null = null;
  #durableVersion = 0;
  #liveVersion = 0;
  #rows: { durable: number; live: number; rows: readonly ClientEvent[] } | null = null;
  #settled: { durable: number; rows: readonly ClientEvent[] } | null = null;
  #live: { durable: number; live: number; turns: readonly LiveTurn[] } | null = null;
  #listeners = new Set<() => void>();
  #notify = frameBatcher(() => {
    for (const listener of this.#listeners) listener();
  });
  readonly #window: number;

  constructor(threadId: string, options: { window?: number } = {}) {
    this.threadId = threadId;
    this.#window = options.window ?? THREAD_WINDOW;
  }

  get durableVersion(): number {
    return this.#durableVersion;
  }

  get liveVersion(): number {
    return this.#liveVersion;
  }

  /** Turns ahead of the thread's waiting one; null when none is waiting. */
  get queued(): number | null {
    return this.#queued;
  }

  /** Takes one event as the client heard it; anything not of this thread is ignored. */
  push(row: ClientEvent): void {
    const event = row.event;
    if (!("threadId" in event) || event.threadId !== this.threadId) return;
    if (row.seq !== null) this.#pushDurable(row, row.seq);
    else if (event.type === "agent.queued") {
      if (this.#queued === event.ahead) return;
      this.#queued = event.ahead;
      this.#changed("live");
    } else if (LIVE.has(event.type)) this.#pushRun(row);
  }

  /** Back from a drop: the runs of turns still open are missing what streamed meanwhile. */
  reset(): void {
    const kept = this.#runs.filter((run) => this.#ended.has(run.turnId));
    if (kept.length === this.#runs.length) return;
    this.#runs = kept;
    this.#changed("live");
  }

  /** For `useSyncExternalStore`: called at most once a frame after anything changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The durable events with each run where it streamed. Unchanged until something is. */
  get rows(): readonly ClientEvent[] {
    const cached = this.#rows;
    if (cached && cached.durable === this.#durableVersion && cached.live === this.#liveVersion) return cached.rows;
    const rows = this.#merge(this.#durable, this.#runs);
    this.#rows = { durable: this.#durableVersion, live: this.#liveVersion, rows };
    return rows;
  }

  /** `rows` without the runs of turns still open. Changes with `durableVersion` only. */
  get durable(): readonly ClientEvent[] {
    const cached = this.#settled;
    if (cached && cached.durable === this.#durableVersion) return cached.rows;
    const rows = this.#merge(
      this.#durable,
      this.#runs.filter((run) => this.#ended.has(run.turnId)),
    );
    this.#settled = { durable: this.#durableVersion, rows };
    return rows;
  }

  /** Each open turn that has streamed: its own durable events with its runs, in order. */
  get live(): readonly LiveTurn[] {
    const cached = this.#live;
    if (cached && cached.durable === this.#durableVersion && cached.live === this.#liveVersion) return cached.turns;
    const open = [...new Set(this.#runs.filter((run) => !this.#ended.has(run.turnId)).map((run) => run.turnId))];
    const turns = open.map((turnId) => ({
      turnId,
      rows: this.#merge(
        this.#durable.filter((row) => "turnId" in row.event && row.event.turnId === turnId),
        this.#runs.filter((run) => run.turnId === turnId),
      ),
    }));
    this.#live = { durable: this.#durableVersion, live: this.#liveVersion, turns };
    return turns;
  }

  /** Stops notifying: the chat moved to another thread or went away. */
  dispose(): void {
    this.#notify.cancel();
    this.#listeners.clear();
  }

  #pushDurable(row: ClientEvent, seq: number): void {
    if (this.#seqs.has(seq)) return;
    // Older than the whole window: already let go of, not to be let back.
    if (this.#durable.length >= this.#window && seq < (this.#durable[0]!.seq ?? -1)) return;
    this.#seqs.add(seq);
    // In order nearly always; a late ack is put back where it belongs.
    let at = this.#durable.length;
    while (at > 0 && (this.#durable[at - 1]!.seq ?? -1) > seq) at--;
    this.#durable.splice(at, 0, row);

    const event = row.event;
    let liveChanged = false;
    // The wait is over: the turn opened, or it never will.
    if ((event.type === "turn.started" || event.type === "turn.dequeued") && this.#queued !== null) {
      this.#queued = null;
      liveChanged = true;
    }
    if ((event.type === "agent.turn_completed" || event.type === "agent.turn_failed") && !this.#ended.has(event.turnId)) {
      this.#ended.add(event.turnId);
      liveChanged = this.#runs.some((run) => run.turnId === event.turnId);
    }

    if (this.#durable.length > this.#window) {
      const dropped = this.#durable.splice(0, this.#durable.length - this.#window);
      for (const old of dropped) this.#seqs.delete(old.seq!);
      // A run follows a durable event; once that has gone, so has it.
      const first = this.#durable[0]!.seq!;
      this.#runs = this.#runs.filter((run) => run.after >= first);
    }
    this.#changed("durable");
    if (liveChanged) this.#changed("live");
  }

  #pushRun(row: ClientEvent): void {
    const event = row.event as LiveEvent;
    const after = this.#durable.at(-1)?.seq ?? -1;
    const last = this.#runs.at(-1);
    if (
      last &&
      last.after === after &&
      (event.type === "agent.text_delta" || event.type === "agent.thinking_delta") &&
      last.row.event.type === event.type &&
      last.turnId === event.turnId
    ) {
      const merged = last.row.event as Extract<LiveEvent, { text: string }>;
      last.row = { ...last.row, event: { ...merged, text: merged.text + event.text } };
    } else {
      this.#runs.push({ after, turnId: event.turnId, row });
    }
    this.#changed(this.#ended.has(event.turnId) ? "durable" : "live");
  }

  /** Durable rows with each run after the newest of them it streamed after. */
  #merge(durable: readonly ClientEvent[], runs: readonly Run[]): readonly ClientEvent[] {
    if (runs.length === 0) return durable.slice();
    const rows: ClientEvent[] = [];
    // Runs are in the order they streamed, so their `after` never goes down.
    let next = 0;
    const before = (limit: number) => {
      while (next < runs.length && runs[next]!.after < limit) rows.push(runs[next++]!.row);
    };
    before(durable[0]?.seq ?? Infinity);
    for (let i = 0; i < durable.length; i++) {
      rows.push(durable[i]!);
      before(durable[i + 1]?.seq ?? Infinity);
    }
    return rows;
  }

  #changed(kind: "durable" | "live"): void {
    if (kind === "durable") this.#durableVersion++;
    else this.#liveVersion++;
    this.#notify.schedule();
  }
}

type LiveEvent = Extract<DomainEvent, { type: "agent.text_delta" | "agent.thinking_delta" | "agent.retry" }>;

/** The unlogged events the chat draws. Composer and presence state are read elsewhere. */
const LIVE: ReadonlySet<DomainEvent["type"]> = new Set(["agent.text_delta", "agent.thinking_delta", "agent.retry"]);

/** A turn still streaming, as `overlayLive` reads it. */
export interface LiveTurn {
  turnId: string;
  rows: readonly ClientEvent[];
}

interface Run {
  /** The durable sequence number it streamed after; -1 before any. */
  after: number;
  turnId: string;
  row: ClientEvent;
}
