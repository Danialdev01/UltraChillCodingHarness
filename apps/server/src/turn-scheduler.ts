/**
 * Who may run an agent turn now, and who waits for a slot.
 *
 * Every turn used to start the moment it was asked for. A Claude Code turn
 * is a process of about 370 MB, and fifty people could start a hundred of
 * them; the one limit there was, per account, failed the turn outright --
 * "Too many agents are running on your account" -- after it had opened.
 * Here a turn over a limit waits instead, before it opens: no `turns` row,
 * nothing billed, and the thread is told how many turns are ahead of it.
 *
 * Four limits:
 *
 * - CLI turns per account (`AGENT_MAX_CONCURRENT_PER_USER`): a subscription
 *   is one person's, and so is its rate limit;
 * - CLI turns in all (`AGENT_MAX_CONCURRENT_TOTAL`): the processes' memory;
 * - native turns in all (`AGENT_MAX_NATIVE_TOTAL`), diagram jobs included:
 *   each is a loop, its context and a model stream held in this process;
 * - OMP turns in all (`OMP_TURN_TOTAL`): each is an `omp` process with its
 *   workers. Not per account -- they bill an OpenRouter key, not a
 *   subscription with a person's rate limit.
 *
 * Waiting turns are served round-robin across accounts, so one person's ten
 * queued turns do not keep everybody else's behind them. Within an account,
 * turns of one kind start in the order they were asked for.
 *
 * Pure bookkeeping: nothing here knows what a turn is beyond its kind.
 */

export type TurnKind = "cli" | "native" | "omp";

export interface TurnLimits {
  cliPerUser: number;
  cliTotal: number;
  nativeTotal: number;
  /** Unlimited when absent. */
  ompTotal?: number;
}

export interface TurnRequest {
  /** The account the turn is billed to: what the per-account limit and the round-robin count by. */
  ownerId: string;
  kind: TurnKind;
  /** The thread the turn is for; a diagram job's own throwaway id. */
  threadId: string;
  /** Aborted while the turn waits: `acquire` rejects and the turn gives up its place. */
  signal?: AbortSignal;
  /**
   * Told how many turns are ahead of this one, whenever that changes while
   * it waits. Never called for a turn that starts at once.
   */
  onAhead?: (ahead: number) => void;
}

interface Waiting extends TurnRequest {
  resolve(release: () => void): void;
  reject(error: Error): void;
  /** Last told through `onAhead`; -1 before the first time. */
  ahead: number;
  onAbort?: () => void;
}

export class TurnScheduler {
  readonly #limits: TurnLimits;
  /**
   * Turns waiting, per account, oldest first. The map's order is the
   * rotation: an account moves to the back each time one of its turns
   * starts, and a new one joins at the back.
   */
  readonly #waiting = new Map<string, Waiting[]>();
  readonly #running: Record<TurnKind, number> = { cli: 0, native: 0, omp: 0 };
  readonly #cliByOwner = new Map<string, number>();

  constructor(limits: TurnLimits) {
    this.#limits = limits;
  }

  /**
   * Resolves with the function that gives the slot back, once the turn may
   * run. Call it however the turn ends -- it is safe to call twice. Rejects
   * with an `AbortError` if `signal` aborts first.
   */
  acquire(request: TurnRequest): Promise<() => void> {
    if (request.signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry: Waiting = { ...request, resolve, reject, ahead: -1 };
      const queue = this.#waiting.get(request.ownerId);
      if (queue) queue.push(entry);
      else this.#waiting.set(request.ownerId, [entry]);
      if (request.signal) {
        entry.onAbort = () => this.#cancel(entry);
        request.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#pump();
    });
  }

  /**
   * An OMP slot for one bridge call (solution §10.5): a Claude Code or
   * Codex turn asking `omp-bridge` for a tool starts an `omp` process, which
   * counts against `OMP_TURN_TOTAL` exactly as an OMP turn does. Unlike a
   * turn, a tool call does not queue for long: it waits at most `waitMs`,
   * then resolves null -- the CLI is told "busy" and carries on without the
   * tool, rather than its whole turn stalling behind other people's work.
   * Null too if `signal` aborts first (the bridge went away).
   */
  async lease(request: { ownerId: string; threadId: string; waitMs: number; signal?: AbortSignal }): Promise<(() => void) | null> {
    const timeout = AbortSignal.timeout(Math.max(0, request.waitMs));
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      return await this.acquire({ ownerId: request.ownerId, kind: "omp", threadId: request.threadId, signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return null;
      throw error;
    }
  }

  /** How many turns are ahead of the thread's waiting turn; null when it has none waiting. */
  aheadOf(threadId: string): number | null {
    for (const queue of this.#waiting.values()) {
      const entry = queue.find((waiting) => waiting.threadId === threadId);
      if (entry) return Math.max(entry.ahead, 0);
    }
    return null;
  }

  /** Turns running and waiting, by kind: for the metrics. */
  stats(): { running: Record<TurnKind, number>; waiting: Record<TurnKind, number> } {
    const waiting: Record<TurnKind, number> = { cli: 0, native: 0, omp: 0 };
    for (const queue of this.#waiting.values()) for (const entry of queue) waiting[entry.kind]++;
    return { running: { ...this.#running }, waiting };
  }

  /** Starts every waiting turn that now fits, one account at a time, then tells the rest where they stand. */
  #pump(): void {
    for (;;) {
      let started = false;
      for (const [ownerId, queue] of this.#waiting) {
        const at = queue.findIndex((entry) => this.#fits(entry));
        if (at < 0) continue;
        const [entry] = queue.splice(at, 1);
        // To the back of the rotation, or out of it with nothing left.
        this.#waiting.delete(ownerId);
        if (queue.length > 0) this.#waiting.set(ownerId, queue);
        this.#start(entry!);
        started = true;
        break;
      }
      if (!started) break;
    }
    this.#announce();
  }

  #fits(entry: Waiting): boolean {
    if (entry.kind === "native") return this.#running.native < this.#limits.nativeTotal;
    if (entry.kind === "omp") return this.#running.omp < (this.#limits.ompTotal ?? Infinity);
    return (
      this.#running.cli < this.#limits.cliTotal &&
      (this.#cliByOwner.get(entry.ownerId) ?? 0) < this.#limits.cliPerUser
    );
  }

  #start(entry: Waiting): void {
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    this.#running[entry.kind]++;
    if (entry.kind === "cli") this.#cliByOwner.set(entry.ownerId, (this.#cliByOwner.get(entry.ownerId) ?? 0) + 1);
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      this.#running[entry.kind]--;
      if (entry.kind === "cli") {
        const left = (this.#cliByOwner.get(entry.ownerId) ?? 1) - 1;
        if (left > 0) this.#cliByOwner.set(entry.ownerId, left);
        else this.#cliByOwner.delete(entry.ownerId);
      }
      this.#pump();
    });
  }

  #cancel(entry: Waiting): void {
    const queue = this.#waiting.get(entry.ownerId);
    const at = queue?.indexOf(entry) ?? -1;
    if (!queue || at < 0) return;
    queue.splice(at, 1);
    if (queue.length === 0) this.#waiting.delete(entry.ownerId);
    entry.reject(abortError());
    this.#announce();
  }

  /**
   * Each waiting turn's place: the order the rotation would start them in,
   * one kind at a time, were slots to free one by one -- each account's
   * first turn in rotation order, then each one's second, and so on.
   */
  #announce(): void {
    for (const kind of ["cli", "native", "omp"] as const) {
      const queues = [...this.#waiting.values()].map((queue) => queue.filter((entry) => entry.kind === kind));
      const longest = Math.max(0, ...queues.map((queue) => queue.length));
      let ahead = 0;
      for (let round = 0; round < longest; round++) {
        for (const queue of queues) {
          const entry = queue[round];
          if (!entry) continue;
          if (entry.ahead !== ahead) {
            entry.ahead = ahead;
            entry.onAhead?.(ahead);
          }
          ahead++;
        }
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("The turn was cancelled while it waited for a slot.");
  error.name = "AbortError";
  return error;
}
