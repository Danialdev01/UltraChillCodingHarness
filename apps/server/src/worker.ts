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
