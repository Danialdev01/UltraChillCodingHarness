/**
 * Which turn of a conversation the reader is on, and the lock that holds a
 * clicked one while the thread scrolls to it.
 *
 * The rules, kept apart from the DOM so they can be tested with numbers: the
 * hook (`use-active-turn.ts`) measures the turns and feeds them in, the rail
 * (`conversation-rail.tsx`) draws what comes out.
 */

/** How far down the scroll box the reading line sits, as a share of its height. */
export const REFERENCE_LINE = 0.3;

/** How close to an end of the box counts as being on it, in pixels. */
export const EDGE_SLACK = 4;

export interface SpyBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * The index of the turn being read, or -1 when there are none.
 *
 * `tops` are each turn's top in the scroll content's coordinates (0 is the
 * top of what scrolls), in thread order. The active turn is the last one whose
 * top has passed a line 30% down the box. On the floor the last turn wins,
 * since a short last turn can never reach the line; at the very top the first
 * does, even if short turns put a second one above the line already. A thread
 * that fits without scrolling is both at once: the newest wins, as that is the
 * one being followed.
 */
export function activeTurnIndex(tops: readonly number[], box: SpyBox): number {
  const n = tops.length;
  if (n === 0) return -1;
  const scrollable = box.scrollHeight - box.clientHeight > EDGE_SLACK;
  if (!scrollable) return n - 1;
  if (box.scrollHeight - box.scrollTop - box.clientHeight <= EDGE_SLACK) return n - 1;
  if (box.scrollTop <= EDGE_SLACK) return 0;
  const line = box.scrollTop + box.clientHeight * REFERENCE_LINE;
  // The tops are in order, so the last one at or above the line is a search.
  let lo = 0;
  let hi = n - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tops[mid] ?? Infinity) <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The highlighted turn, and whether a jump is holding it.
 *
 * While `locked`, what the scroll position says is ignored: a smooth scroll
 * passes every turn between here and there, and following it would run the
 * highlight down the rail. The lock lifts when the scroll settles or when the
 * reader takes the wheel themselves.
 */
export interface SpyState {
  activeId: string | null;
  locked: boolean;
}

export type SpyEvent =
  /** A tick was chosen: highlight it now and hold it. */
  | { type: "jump"; id: string }
  /** What the scroll position says. Dropped while a jump holds. */
  | { type: "spy"; id: string | null }
  /** The jump's scroll finished. The clicked turn stays until the reader scrolls. */
  | { type: "settle" }
  /** The reader scrolled by hand mid-jump: let go, and take their position. */
  | { type: "manual"; id: string | null }
  /** Another session: nothing carries over. */
  | { type: "reset" };

export const initialSpy: SpyState = { activeId: null, locked: false };

export function spyReducer(state: SpyState, event: SpyEvent): SpyState {
  switch (event.type) {
    case "jump":
      return { activeId: event.id, locked: true };
    case "spy":
      if (state.locked || state.activeId === event.id) return state;
      return { ...state, activeId: event.id };
    case "settle":
      return state.locked ? { ...state, locked: false } : state;
    case "manual":
      if (!state.locked && state.activeId === event.id) return state;
      return { activeId: event.id, locked: false };
    case "reset":
      return state === initialSpy ? state : initialSpy;
  }
}

/**
 * The first line of a prompt, for the rail's tooltip and label.
 *
 * Cut at `max` characters with an ellipsis. A prompt that is only files is
 * named by them, so its tick still says something.
 */
export function turnPreview(text: string, attachments: readonly { name: string }[] = [], max = 60): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const raw = line ?? (attachments.length > 0 ? attachments.map((a) => a.name).join(", ") : "(empty message)");
  const chars = Array.from(raw);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : raw;
}

/**
 * Where to set a scroller's `scrollTop` so a row inside it is fully in view,
 * moving it as little as possible; `null` when it already is.
 */
export function revealRow(row: { top: number; height: number }, view: { scrollTop: number; clientHeight: number }): number | null {
  if (row.top < view.scrollTop) return row.top;
  if (row.top + row.height > view.scrollTop + view.clientHeight) return row.top + row.height - view.clientHeight;
  return null;
}
