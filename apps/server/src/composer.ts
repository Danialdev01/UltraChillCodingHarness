import { EMPTY_COMPOSER_DRAFT, type ChangeOrigin, type ComposerDraft } from "@ucch/protocol";

export interface ComposerState {
  rev: number;
  draft: ComposerDraft;
  origin: ChangeOrigin | null;
}

export type ComposerUpdate =
  | { ok: true; state: ComposerState }
  /** Somebody else wrote after `baseRev`; `state` is what they wrote. */
  | { ok: false; state: ComposerState };

/** How many threads' drafts are kept before the oldest empty ones go. */
const MAX_DRAFTS = 5_000;

/**
 * The prompt box of every thread, shared between the tabs showing it.
 *
 * In memory on purpose: a draft is not history, and losing one to a restart
 * costs a half-typed sentence, not a record. Each thread's draft carries a
 * rev that only goes up; an update must name the rev it was typed against,
 * so two windows typing at once cannot silently overwrite each other -- the
 * later one is refused and shown what the earlier one wrote.
 *
 * Revs come from one counter for the whole process rather than per thread,
 * so a draft evicted and recreated can never reissue a rev a tab still holds.
 */
export class ComposerStore {
  #drafts = new Map<string, ComposerState>();
  #rev = 0;

  get(threadId: string): ComposerState {
    return this.#drafts.get(threadId) ?? { rev: 0, draft: EMPTY_COMPOSER_DRAFT, origin: null };
  }

  update(threadId: string, baseRev: number, draft: ComposerDraft, origin: ChangeOrigin): ComposerUpdate {
    const current = this.get(threadId);
    if (current.rev !== baseRev) return { ok: false, state: current };
    return { ok: true, state: this.#put(threadId, draft, origin) };
  }

  /** Empties it after a send. Not checked against a rev: the message is already on its way. */
  clear(threadId: string): ComposerState {
    return this.#put(threadId, EMPTY_COMPOSER_DRAFT, null);
  }

  #put(threadId: string, draft: ComposerDraft, origin: ChangeOrigin | null): ComposerState {
    const state = { rev: ++this.#rev, draft, origin };
    // Re-inserted so the map's order is least recently written first.
    this.#drafts.delete(threadId);
    this.#drafts.set(threadId, state);
    if (this.#drafts.size > MAX_DRAFTS) this.#evict();
    return state;
  }

  #evict(): void {
    for (const [threadId, state] of this.#drafts) {
      if (this.#drafts.size <= MAX_DRAFTS) return;
      if (isEmpty(state.draft)) this.#drafts.delete(threadId);
    }
    // Every draft has something in it: the oldest goes regardless.
    const oldest = this.#drafts.keys().next();
    if (!oldest.done && this.#drafts.size > MAX_DRAFTS) this.#drafts.delete(oldest.value);
  }
}

function isEmpty(draft: ComposerDraft): boolean {
  return !draft.text && draft.attachments.length === 0 && !draft.reference;
}
