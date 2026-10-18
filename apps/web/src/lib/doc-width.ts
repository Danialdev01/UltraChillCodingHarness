/**
 * How wide a documentation page reads: a per-browser preference, kept and
 * announced the way the font sizes are (see `font-size-preference.ts`) --
 * in `localStorage`, with an event on `document` so an open page follows a
 * change made on the settings page without being remounted.
 *
 * A few named widths rather than a number of pixels: a page is measured in
 * lines of prose, and "Wide" means the same on a laptop and a 4K screen in a
 * way 1100px does not. Anything stored that is not one of them reads as the
 * default.
 */

export const DOC_WIDTHS = [
  { id: "narrow", label: "Narrow", maxWidth: "40rem" },
  // `max-w-3xl`, which is what the page was before there was a choice.
  { id: "default", label: "Default", maxWidth: "48rem" },
  { id: "wide", label: "Wide", maxWidth: "64rem" },
  { id: "full", label: "Full width", maxWidth: "100%" },
] as const;

export type DocWidth = (typeof DOC_WIDTHS)[number]["id"];

export const DEFAULT_DOC_WIDTH: DocWidth = "default";

/** Where the choice lives between visits. */
export const DOC_WIDTH_STORAGE_KEY = "ucch:doc-width";

/** Dispatched on `document` when the choice changes, with the new width as `detail`. */
export const DOC_WIDTH_EVENT = "ucch:doc-width";

/** The width a value names, or null for anything that is not one. */
export function parseDocWidth(value: unknown): DocWidth | null {
  return DOC_WIDTHS.find((w) => w.id === value)?.id ?? null;
}

/** The CSS `max-width` a page at `width` is held to. */
export function docMaxWidth(width: DocWidth): string {
  return DOC_WIDTHS.find((w) => w.id === width)!.maxWidth;
}

export function readDocWidth(): DocWidth {
  try {
    return parseDocWidth(globalThis.localStorage?.getItem(DOC_WIDTH_STORAGE_KEY)) ?? DEFAULT_DOC_WIDTH;
  } catch {
    return DEFAULT_DOC_WIDTH;
  }
}

/** Stores the width and returns what was actually stored. */
export function writeDocWidth(value: unknown): DocWidth {
  const width = parseDocWidth(value) ?? DEFAULT_DOC_WIDTH;
  try {
    globalThis.localStorage?.setItem(DOC_WIDTH_STORAGE_KEY, width);
  } catch {
    /* nothing to do: the choice simply is not remembered */
  }
  globalThis.document?.dispatchEvent(new CustomEvent(DOC_WIDTH_EVENT, { detail: width }));
  return width;
}

/**
 * Calls `listener` with the new width whenever the choice changes -- from the
 * settings page in this tab, or from another tab through the `storage` event.
 * Returns the unsubscribe.
 */
export function watchDocWidth(listener: (width: DocWidth) => void): () => void {
  const doc = globalThis.document;
  if (!doc) return () => {};
  function onLocal(e: Event) {
    const width = parseDocWidth((e as CustomEvent<unknown>).detail);
    if (width !== null) listener(width);
  }
  function onStorage(e: StorageEvent) {
    if (e.key !== DOC_WIDTH_STORAGE_KEY) return;
    listener(parseDocWidth(e.newValue) ?? DEFAULT_DOC_WIDTH);
  }
  doc.addEventListener(DOC_WIDTH_EVENT, onLocal);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    doc.removeEventListener(DOC_WIDTH_EVENT, onLocal);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
