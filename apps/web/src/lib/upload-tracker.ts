/**
 * The uploads a composer still has in flight, so a send can wait for them.
 *
 * Every way of sending -- the button, Enter, a widget -- goes through one
 * `send`, and that is where the wait belongs: a message that left before its
 * picture finished uploading would reach the model without it.
 */
export class UploadTracker {
  readonly #pending = new Set<Promise<unknown>>();

  /** `onChange` hears every start and finish, so a component can re-render. */
  constructor(private readonly onChange?: () => void) {}

  /** Follows `work` until it settles, whether it succeeds or not. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(settled);
    this.onChange?.();
    void settled.then(() => {
      this.#pending.delete(settled);
      this.onChange?.();
    });
    return work;
  }

  /** How many uploads are still running. */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * Resolves once nothing is in flight -- including uploads that started
   * while this was waiting, such as a second paste. Never rejects: a failed
   * upload is its chip's business, not the send's.
   */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}
