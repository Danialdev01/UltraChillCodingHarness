/**
 * A font size kept as a per-browser preference, in CSS pixels.
 *
 * It is about the screen and the eyes in front of it, not the account: kept
 * in `localStorage`, and announced on the document when it changes so
 * whatever renders at that size re-renders without being torn down. One
 * factory for the editor and the file tree alike, so the two cannot differ in
 * how they clamp, store or announce.
 *
 * Clamped rather than validated away: 6px is unreadable and 60px is a poster,
 * and whatever a stale or hand-edited value says, the thing should still come
 * up at something usable.
 */

export interface FontSizePreference {
  defaultSize: number;
  min: number;
  max: number;
  /** Where the choice lives between visits. */
  storageKey: string;
  /** Dispatched on `document` when the choice changes, with the new size as `detail`. */
  event: string;
  /** A whole number of pixels within range, or null for anything that is not one. */
  parse(value: unknown): number | null;
  read(): number;
  /** Stores the size, clamped, and returns what was actually stored. */
  write(value: number): number;
  /**
   * Calls `listener` with the new size whenever the choice changes -- from
   * the settings page in this tab, or from another tab of the same browser
   * through the `storage` event. Returns the unsubscribe.
   */
  watch(listener: (size: number) => void): () => void;
}

export function fontSizePreference({
  defaultSize,
  min,
  max,
  storageKey,
  event,
}: Pick<FontSizePreference, "defaultSize" | "min" | "max" | "storageKey" | "event">): FontSizePreference {
  function parse(value: unknown): number | null {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function read(): number {
    try {
      return parse(globalThis.localStorage?.getItem(storageKey)) ?? defaultSize;
    } catch {
      return defaultSize;
    }
  }

  function write(value: number): number {
    const size = parse(value) ?? defaultSize;
    try {
      globalThis.localStorage?.setItem(storageKey, String(size));
    } catch {
      /* nothing to do: the choice simply is not remembered */
    }
    globalThis.document?.dispatchEvent(new CustomEvent(event, { detail: size }));
    return size;
  }

  function watch(listener: (size: number) => void): () => void {
    const doc = globalThis.document;
    if (!doc) return () => {};
    function onLocal(e: Event) {
      const size = parse((e as CustomEvent<unknown>).detail);
      if (size !== null) listener(size);
    }
    function onStorage(e: StorageEvent) {
      if (e.key !== storageKey) return;
      listener(parse(e.newValue) ?? defaultSize);
    }
    doc.addEventListener(event, onLocal);
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      doc.removeEventListener(event, onLocal);
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }

  return { defaultSize, min, max, storageKey, event, parse, read, write, watch };
}
