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
  /** Shared estimated working-set budget; absent preserves count-only scheduling. */
  memory?: { budgetMb: number; estimatesMb: Record<TurnKind, number> };
  maxWaiting?: number;
  waitTimeoutMs?: number;
}

/** One reading of how much memory is in use, from the resource sampler. */
export interface MemoryReading {
  /** Bytes in use, reclaimable page cache excluded. */
  usedBytes: number;
  /** Bytes there are to use: the cgroup's limit, or the host's total. */
  limitBytes: number;
  /** When it was read (ms, the same clock as `now`). */
  at: number;
}

/**
 * Admission by measured memory, beside the counts and the estimate budget:
 * no new turn starts while the container is near its limit. Turns already
 * running carry on -- this only holds back new ones.
 *
 * Starts pause once use reaches `pauseRatio` of the limit and resume only
 * below `resumeRatio`, so admission does not flap around one threshold. A
 * turn started shortly before the latest reading has not fully shown up in
 * it yet, so its estimate counts on top until a reading `settleMs` after its
 * start arrives -- conservative: for a while it counts twice. A
 * reading older than `staleMs` (or none at all) holds starts back too: with
 * no figures, nothing says there is room.
 */
export interface MemoryPressure {
  read(): MemoryReading | null;
  pauseRatio: number;
  resumeRatio: number;
  staleMs: number;
  estimatesMb: Record<TurnKind, number>;
  /**
   * How long after its start a turn's estimate keeps counting on top of the
   * readings: a CLI takes a while to grow to its working set, so the first
   * reading after it starts does not yet show all of it. Default 30 s.
   */
  settleMs?: number;
  now?: () => number;
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
  timer?: ReturnType<typeof setTimeout>;
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
  #pressure: MemoryPressure | null = null;
  /** Under pressure: starts stay paused until use drops below `resumeRatio`. */
  #pressurePaused = false;
  /** Turns started recently, and their estimates: not yet in any reading. */
  #recentStarts: { at: number; bytes: number }[] = [];

  constructor(limits: TurnLimits) {
    if (limits.memory && (!Number.isFinite(limits.memory.budgetMb) || limits.memory.budgetMb <= 0 ||
      Object.values(limits.memory.estimatesMb).some((n) => !Number.isFinite(n) || n <= 0))) {
      throw new Error("Memory budget and estimates must be finite positive numbers.");
    }
    this.#limits = limits;
  }

  /**
   * Resolves with the function that gives the slot back, once the turn may
   * run. Call it however the turn ends -- it is safe to call twice. Rejects
   * with an `AbortError` if `signal` aborts first.
   */
  acquire(request: TurnRequest): Promise<() => void> {
    if (request.signal?.aborted) return Promise.reject(abortError());
    const memory = this.#limits.memory;
    if (memory && memory.estimatesMb[request.kind] > memory.budgetMb) {
      return Promise.reject(new Error("This turn exceeds the configured agent memory budget."));
    }
    const waiting = this.stats().waiting;
    if (this.#limits.maxWaiting !== undefined && waiting.cli + waiting.native + waiting.omp >= this.#limits.maxWaiting) {
      return Promise.reject(new Error("The agent waiting queue is full. Try again later."));
    }
    return new Promise((resolve, reject) => {
      const entry: Waiting = { ...request, resolve, reject, ahead: -1 };
      const queue = this.#waiting.get(request.ownerId);
      if (queue) queue.push(entry);
      else this.#waiting.set(request.ownerId, [entry]);
      if (request.signal) {
        entry.onAbort = () => this.#cancel(entry);
        request.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (this.#limits.waitTimeoutMs !== undefined) {
        entry.timer = setTimeout(() => this.#cancel(entry, new Error("Timed out waiting for agent capacity.")), this.#limits.waitTimeoutMs);
        entry.timer.unref();
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

  /**
   * Turns admission by measured memory on (or off, with null). Set once the
   * sampler is known to have figures; a server without `/proc` keeps
   * count-only scheduling rather than waiting forever for a reading.
   */
  setMemoryPressure(pressure: MemoryPressure | null): void {
    if (pressure && !(pressure.resumeRatio > 0 && pressure.resumeRatio <= pressure.pauseRatio && pressure.pauseRatio <= 1)) {
      throw new Error("Memory pressure ratios must satisfy 0 < resume <= pause <= 1.");
    }
    this.#pressure = pressure;
    this.#pressurePaused = false;
    this.#recentStarts = [];
    this.#pump();
  }

  /** Looks again at the waiting turns: call it when a new memory reading arrives. */
  recheck(): void {
    this.#pump();
  }

  /** Whether new starts are held back by measured memory right now. */
  get pressurePaused(): boolean {
    return this.#pressurePaused;
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
      if (this.#waiting.size === 0) break;
      for (const [ownerId, queue] of this.#waiting) {
        const at = queue.findIndex((entry) => this.#fits(entry) && this.#pressureAllows(entry.kind));
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

  /** Estimates remain reserved for the entire turn, including bridge calls. Not an RSS measurement. */
  reservedMemoryMb(): number {
    const memory = this.#limits.memory;
    if (!memory) return 0;
    return this.#running.cli * memory.estimatesMb.cli + this.#running.omp * memory.estimatesMb.omp +
      this.#running.native * memory.estimatesMb.native;
  }

  #fits(entry: Waiting): boolean {
    const memory = this.#limits.memory;
    if (memory && this.reservedMemoryMb() + memory.estimatesMb[entry.kind] > memory.budgetMb) return false;
    if (entry.kind === "native") return this.#running.native < this.#limits.nativeTotal;
    if (entry.kind === "omp") return this.#running.omp < (this.#limits.ompTotal ?? Infinity);
    return (
      this.#running.cli < this.#limits.cliTotal &&
      (this.#cliByOwner.get(entry.ownerId) ?? 0) < this.#limits.cliPerUser
    );
  }

  /**
   * Whether measured memory leaves room for one more turn of this kind.
   * Updates the pause state as a side effect, so the hysteresis holds
   * across calls.
   */
  #pressureAllows(kind: TurnKind): boolean {
    const pressure = this.#pressure;
    if (!pressure) return true;
    const now = (pressure.now ?? Date.now)();
    const reading = pressure.read();
    if (!reading || reading.limitBytes <= 0 || now - reading.at > pressure.staleMs) return false;
    this.#recentStarts = this.#recentStarts.filter((start) => start.at + (pressure.settleMs ?? 30_000) > reading.at);
    const pending = this.#recentStarts.reduce((sum, start) => sum + start.bytes, 0);
    const share = (reading.usedBytes + pending) / reading.limitBytes;
    if (this.#pressurePaused) {
      if (share >= pressure.resumeRatio) return false;
      this.#pressurePaused = false;
    } else if (share >= pressure.pauseRatio) {
      this.#pressurePaused = true;
      return false;
    }
    // The turn itself must fit under the pause line too.
    const after = (reading.usedBytes + pending + pressure.estimatesMb[kind] * MB) / reading.limitBytes;
    return after < pressure.pauseRatio;
  }

  #start(entry: Waiting): void {
    clearTimeout(entry.timer);
    if (this.#pressure) {
      this.#recentStarts.push({ at: (this.#pressure.now ?? Date.now)(), bytes: this.#pressure.estimatesMb[entry.kind] * MB });
    }
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

  #cancel(entry: Waiting, error: Error = abortError()): void {
    const queue = this.#waiting.get(entry.ownerId);
    const at = queue?.indexOf(entry) ?? -1;
    if (!queue || at < 0) return;
    queue.splice(at, 1);
    if (queue.length === 0) this.#waiting.delete(entry.ownerId);
    clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
    entry.reject(error);
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

const MB = 1024 * 1024;

function abortError(): Error {
  const error = new Error("The turn was cancelled while it waited for a slot.");
  error.name = "AbortError";
  return error;
}
