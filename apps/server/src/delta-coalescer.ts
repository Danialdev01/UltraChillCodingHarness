import type { DomainEvent } from "@ucch/protocol";

export type Delta = Extract<DomainEvent, { type: "agent.text_delta" | "agent.thinking_delta" }>;

export function isDelta(event: DomainEvent): event is Delta {
  return event.type === "agent.text_delta" || event.type === "agent.thinking_delta";
}

export interface CoalescerOptions {
  /** How long a run is held before it goes out. */
  flushMs: number;
  /** A run this long goes out at once, without waiting for the timer. */
  maxChars?: number;
}

/** Characters buffered before a run is sent without waiting for the timer. */
export const COALESCE_MAX_CHARS = 2048;

/**
 * Folds a turn's streamed tokens into fewer, larger deltas.
 *
 * Every chunk a model streams was its own event, and so its own bus
 * publication and its own frame to every subscriber -- for a long answer,
 * thousands of frames carrying a few characters each. Here consecutive
 * deltas of one kind and one turn are merged into a run, and the run goes
 * out every `flushMs` (or at once when it reaches `maxChars`).
 *
 * - A turn's first delta goes out at once, so the time to the first token
 *   does not change.
 * - A delta of the other kind, or another turn's, ends the run: thinking
 *   and text keep their order.
 * - `flush()` sends what is held now. The caller calls it before anything
 *   durable, so a tool call never overtakes the text that came before it,
 *   and on the way out of a turn, so its tail is never lost.
 */
export class DeltaCoalescer {
  #run: Delta | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = new Set<string>();
  readonly #maxChars: number;

  constructor(
    private readonly emit: (delta: Delta) => void,
    private readonly options: CoalescerOptions,
  ) {
    this.#maxChars = options.maxChars ?? COALESCE_MAX_CHARS;
  }

  push(delta: Delta): void {
    if (!this.#started.has(delta.turnId)) {
      this.#started.add(delta.turnId);
      this.flush();
      this.emit(delta);
      return;
    }
    const run = this.#run;
    if (run && run.type === delta.type && run.turnId === delta.turnId) {
      this.#run = { ...run, text: run.text + delta.text };
    } else {
      this.flush();
      this.#run = delta;
    }
    if (this.#run.text.length >= this.#maxChars) {
      this.flush();
      return;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.options.flushMs);
  }

  /** Sends the run held now, if any. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const run = this.#run;
    if (!run) return;
    this.#run = null;
    this.emit(run);
  }

  /** Sends what is held and stops the timer: the turn is over. */
  dispose(): void {
    this.flush();
    this.#started.clear();
  }
}
