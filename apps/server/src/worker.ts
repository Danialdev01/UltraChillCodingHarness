/**
 * A queue whose outstanding-item count is observable.
 *
 * The point is testability. Reactors do asynchronous work in response to
 * events, and a test that wants to assert on the result has to know when that
 * work is finished. `drain()` resolves when the queue is genuinely empty and
 * no handler is still in flight, which lets tests await real completion
 * instead of sleeping and hoping.
 */
export class DrainableWorker<T> {
  readonly name: string;
  #queue: T[] = [];
  #inFlight = 0;
  #running = false;
  #stopped = false;
  #idleWaiters: Array<() => void> = [];

  constructor(
    name: string,
    private readonly handler: (item: T) => Promise<void>,
    private readonly onError: (error: unknown, item: T) => void = () => {},
  ) {
    this.name = name;
  }

  push(item: T): void {
    if (this.#stopped) throw new Error(`worker ${this.name} is stopped`);
    this.#queue.push(item);
    void this.#pump();
  }

  get outstanding(): number {
    return this.#queue.length + this.#inFlight;
  }

  /** Resolves once the queue is empty and every in-flight handler has settled. */
  async drain(): Promise<void> {
    if (this.outstanding === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.drain();
  }

  async #pump(): Promise<void> {
    // A single pump loop keeps handlers serialized. Reactors mutate
    // containers and git refs; running two concurrently on the same project
    // is a race we do not want to reason about.
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        this.#inFlight++;
        try {
          await this.handler(item);
        } catch (error) {
          this.onError(error, item);
        } finally {
          this.#inFlight--;
        }
      }
    } finally {
      this.#running = false;
      if (this.outstanding === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }
}

/**
 * A `DrainableWorker` per key, run side by side: items with the same key
 * one at a time and in order, items with different keys in parallel, at
 * most `maxParallel` handlers at once across all of them.
 *
 * A key's worker is made on its first item and dropped once it has none
 * left, so the map holds only keys with work in it. `outstanding`, `drain()`
 * and `stop()` cover every key, which keeps callers written for one
 * `DrainableWorker` unchanged.
 */
export class KeyedWorker<T> {
  readonly name: string;
  #lanes = new Map<string, { worker: DrainableWorker<T>; pending: number }>();
  #outstanding = 0;
  #active = 0;
  #permitWaiters: Array<() => void> = [];
  #idleWaiters: Array<() => void> = [];
  #stopped = false;

  constructor(
    name: string,
    private readonly maxParallel: number,
    private readonly handler: (item: T) => Promise<void>,
    private readonly onError: (error: unknown, item: T) => void = () => {},
  ) {
    this.name = name;
  }

  push(key: string, item: T): void {
    if (this.#stopped) throw new Error(`worker ${this.name} is stopped`);
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { worker: new DrainableWorker(`${this.name}:${key}`, (i) => this.#run(key, i), this.onError), pending: 0 };
      this.#lanes.set(key, lane);
    }
    lane.pending++;
    this.#outstanding++;
    lane.worker.push(item);
  }

  get outstanding(): number {
    return this.#outstanding;
  }

  /** Handlers running right now, across every key. */
  get active(): number {
    return this.#active;
  }

  /** Keys with work queued or in flight. */
  get keys(): number {
    return this.#lanes.size;
  }

  /** Resolves once no key has anything queued or in flight. */
  async drain(): Promise<void> {
    if (this.#outstanding === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.drain();
  }

  async #run(key: string, item: T): Promise<void> {
    // The key's own worker already keeps its items in order; this bounds
    // how many keys run at once, so a burst across many projects cannot
    // take more database connections than the pool has.
    if (this.#active >= this.maxParallel) {
      await new Promise<void>((resolve) => this.#permitWaiters.push(resolve));
    } else {
      this.#active++;
    }
    try {
      await this.handler(item);
    } finally {
      // The permit passes straight to the next waiter, so `#active` never
      // dips and a newcomer cannot slip in ahead of it.
      const next = this.#permitWaiters.shift();
      if (next) next();
      else this.#active--;

      const lane = this.#lanes.get(key);
      if (lane && --lane.pending === 0) this.#lanes.delete(key);
      if (--this.#outstanding === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }
}
