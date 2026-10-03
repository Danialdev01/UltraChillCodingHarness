/**
 * Saving a page as it is typed.
 *
 * Pure -- no React, no fetch -- so the timing rules can be tested with fake
 * timers. The rules: edits within a window coalesce into one save; a save is
 * never started while one is in flight (the edit waits and goes next); a
 * failed save keeps the edit pending so the next attempt carries it; and each
 * save sends the `updatedAt` the last one returned, so a page saved from
 * another tab in between is a conflict rather than an overwrite. A conflict
 * drops what was waiting: the other tab's version stands, and the editor
 * reverts to it.
 */

import type { NoteDoc } from "@ucch/protocol";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface NotePatchInput {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  content?: NoteDoc;
}

export interface AutosaveOptions {
  /** How long after the last edit to save. */
  delayMs: number;
  /** The `updatedAt` of the page as it was opened. */
  updatedAt: string;
  /** Sends one patch. Rejects with `{ conflict: true }`-shaped errors on a stale write. */
  save(patch: NotePatchInput & { ifUpdatedAt: string }): Promise<{ updatedAt: string }>;
  onStatus(status: SaveStatus, error?: unknown): void;
  /** The error `save` rejects with when the page changed elsewhere. */
  isConflict?(error: unknown): boolean;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface Autosave {
  /** Records an edit. Coalesces with whatever is already waiting. */
  update(patch: NotePatchInput): void;
  /** Saves what is waiting now, and resolves once nothing is. */
  flush(): Promise<void>;
  /** Whether an edit has not yet reached the server. */
  readonly pending: boolean;
  /** The `updatedAt` the server last confirmed. */
  readonly updatedAt: string;
  /**
   * Adopts a version fetched from elsewhere -- another tab's save, applied to
   * the editor -- so the next write is checked against it, not the old one.
   */
  accept(updatedAt: string): void;
  /** Stops the timer. Nothing waiting is saved; call `flush` first if it should be. */
  dispose(): void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isConflict = options.isConflict ?? (() => false);

  let waiting: NotePatchInput | null = null;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let updatedAt = options.updatedAt;
  let disposed = false;

  function clearTimer() {
    if (timer !== null) clearT(timer);
    timer = null;
  }

  async function run(): Promise<void> {
    // Loop rather than recurse: an edit made while a save is in flight is
    // picked up by the same run, so there is never more than one.
    while (waiting && !disposed) {
      const patch = waiting;
      waiting = null;
      options.onStatus("saving");
      try {
        const result = await options.save({ ...patch, ifUpdatedAt: updatedAt });
        updatedAt = result.updatedAt;
        if (!waiting) options.onStatus("saved");
      } catch (error) {
        if (isConflict(error)) {
          // Somebody else saved first. Their version wins and this tab's
          // unsaved edits -- the ones refused and any typed since -- are
          // dropped: the editor reverts to what they saved and says so.
          waiting = null;
          options.onStatus("conflict", error);
          return;
        }
        // The edit is not lost: it goes back under anything typed since, so
        // the next attempt carries both.
        waiting = { ...patch, ...(waiting ?? {}) };
        options.onStatus("error", error);
        return;
      }
    }
  }

  function start(): Promise<void> {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    update(patch) {
      if (disposed) return;
      waiting = { ...waiting, ...patch };
      options.onStatus("dirty");
      clearTimer();
      timer = setT(() => {
        timer = null;
        void start();
      }, options.delayMs);
    },
    async flush() {
      clearTimer();
      if (!waiting && !inFlight) return;
      await start();
    },
    get pending() {
      return waiting !== null || inFlight !== null;
    },
    get updatedAt() {
      return updatedAt;
    },
    accept(next) {
      updatedAt = next;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
