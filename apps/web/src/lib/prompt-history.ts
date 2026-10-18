/**
 * Walking back through what you already asked.
 *
 * Up puts the previous user message in the composer, Up again the one
 * before it, Down comes forward, and stepping past the newest restores
 * whatever was being typed when the walk began -- the same contract as a
 * shell's history, which is what the keys are borrowed from.
 *
 * The bare arrows only while the caret sits at the end of the draft (an
 * empty draft always does), so a caret moved into a multi-line draft still
 * travels it with the arrow keys alone; a recalled entry puts the caret at
 * its end, so the walk continues key after key. Alt+Up / Alt+Down recall
 * wherever the caret is.
 *
 * Pure: the composer holds a `HistoryCursor` and feeds it keystrokes.
 */

export interface HistoryCursor {
  /**
   * Index into `entries` of what the composer currently shows, or null when
   * it shows the live draft rather than a recalled entry.
   */
  index: number | null;
  /** What was being typed before the walk began; restored on the way out. */
  stash: string;
}

export const idleCursor: HistoryCursor = { index: null, stash: "" };

/**
 * One step. `entries` is oldest first; a repeated consecutive entry is
 * skipped so pressing the key twice never shows the same text twice.
 * Returns the new cursor and the text to show, or null when there is
 * nowhere to go (at the oldest entry, or already on the live draft).
 */
export function step(
  cursor: HistoryCursor,
  direction: "back" | "forward",
  entries: readonly string[],
  draft: string,
): { cursor: HistoryCursor; text: string } | null {
  const shown = cursor.index === null ? draft : entries[cursor.index];

  if (direction === "back") {
    let at = cursor.index === null ? entries.length - 1 : cursor.index - 1;
    while (at >= 0 && entries[at] === shown) at--;
    if (at < 0) return null;
    return {
      cursor: { index: at, stash: cursor.index === null ? draft : cursor.stash },
      text: entries[at]!,
    };
  }

  if (cursor.index === null) return null;
  let at = cursor.index + 1;
  while (at < entries.length && entries[at] === shown) at++;
  if (at >= entries.length) return { cursor: idleCursor, text: cursor.stash };
  return { cursor: { ...cursor, index: at }, text: entries[at]! };
}

/**
 * Whether a keydown is one of the two history keys. `caretAtEnd` is true when
 * nothing is selected and the caret is after the draft's last character.
 */
export function historyDirection(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  caretAtEnd: boolean;
}): "back" | "forward" | null {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (!event.altKey && !event.caretAtEnd) return null;
  if (event.key === "ArrowUp") return "back";
  if (event.key === "ArrowDown") return "forward";
  return null;
}
