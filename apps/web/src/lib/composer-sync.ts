/**
 * Keeping one thread's prompt box the same in every window.
 *
 * Pure -- no React, no socket -- so the rules can be tested with fake timers:
 *
 * - A local edit is sent after a short pause, one update in flight at a time;
 *   an edit made while one is in flight goes when it is answered.
 * - Each update names the rev its text was typed against. That rev moves on
 *   only when this window adopts a draft -- another window's, or its own
 *   echoed back -- never merely because one went past while it was typing.
 *   So two windows typing at once cannot both win: the later one is refused.
 * - A remote draft is shown at once when this window has nothing unsent.
 *   Otherwise it is held, and if this window's update is then refused, the
 *   held draft replaces what was typed here: an error, and a revert.
 */

import type { ComposerDraft } from "@ucch/protocol";

export interface ComposerEvent {
  rev: number;
  draft: ComposerDraft;
  /** This window's own update, echoed back. */
  own: boolean;
}

export interface ComposerSyncOptions {
  delayMs: number;
  send(baseRev: number, draft: ComposerDraft): Promise<void>;
  /** Whether a rejection from `send` means another window wrote first. */
  isConflict(error: unknown): boolean;
  /** Puts a draft from elsewhere into the prompt box. */
  apply(draft: ComposerDraft): void;
  /** This window's edits were refused and replaced by `apply`. */
  onReverted(): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ComposerSync {
  /** The prompt box changed here. A draft equal to the last one synced is ignored. */
  local(draft: ComposerDraft): void;
  /** The server said what the prompt box now holds. */
  remote(event: ComposerEvent): void;
  /**
   * Forgets anything unsent without sending it: the message went, and the
   * server is about to clear the box for every window.
   */
  discard(): void;
  readonly pending: boolean;
  dispose(): void;
}

export function draftKey(draft: ComposerDraft): string {
  return JSON.stringify([
    draft.text,
    draft.attachments.map((a) => a.uploadId ?? a.id),
    draft.reference,
    draft.research ?? false,
    draft.effort ?? null,
  ]);
}

export function createComposerSync(options: ComposerSyncOptions): ComposerSync {
  const setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  /** The rev the text here was typed against. */
  let baseRev = 0;
  /** What the server and this window last agreed the box holds. */
  let synced = draftKey({ text: "", attachments: [], reference: null });
  let waiting: ComposerDraft | null = null;
  let inFlight = false;
  let timer: unknown = null;
  /** The newest draft from elsewhere, held while this window has its own unsent. */
  let held: ComposerEvent | null = null;
  let disposed = false;

  function schedule() {
    if (timer !== null || inFlight || disposed) return;
    timer = setT(() => {
      timer = null;
      void flush();
    }, options.delayMs);
  }

  async function flush() {
    if (!waiting || inFlight || disposed) return;
    const draft = waiting;
    waiting = null;
    inFlight = true;
    try {
      await options.send(baseRev, draft);
      synced = draftKey(draft);
    } catch (error) {
      if (options.isConflict(error)) {
        // Another window wrote first. Its draft -- pushed just before the
        // refusal -- replaces everything typed here that had not gone.
        waiting = null;
        if (held) adopt(held);
        options.onReverted();
      } else {
        // Not a clash, just not delivered: try again with whatever is newest.
        waiting = waiting ?? draft;
      }
    } finally {
      inFlight = false;
    }
    if (waiting) schedule();
  }

  function adopt(event: ComposerEvent) {
    baseRev = event.rev;
    synced = draftKey(event.draft);
    held = null;
    options.apply(event.draft);
  }

  return {
    local(draft) {
      if (disposed) return;
      if (draftKey(draft) === synced && !waiting) return;
      waiting = draft;
      schedule();
    },
    remote(event) {
      if (disposed) return;
      if (event.own) {
        // Ours, back from the server: what was typed since builds on it.
        baseRev = event.rev;
        return;
      }
      if (waiting || inFlight) {
        held = event;
        return;
      }
      adopt(event);
    },
    discard() {
      waiting = null;
      if (timer !== null) clearT(timer);
      timer = null;
    },
    get pending() {
      return waiting !== null || inFlight;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
