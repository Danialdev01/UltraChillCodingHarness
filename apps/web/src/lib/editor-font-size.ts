/**
 * The font size the file editor renders at, in CSS pixels. See
 * `font-size-preference.ts` for how it is kept and announced.
 */

import { fontSizePreference } from "./font-size-preference";

export const DEFAULT_EDITOR_FONT_SIZE = 12;
export const MIN_EDITOR_FONT_SIZE = 8;
export const MAX_EDITOR_FONT_SIZE = 32;

/** Where the choice lives between visits. */
export const EDITOR_FONT_SIZE_STORAGE_KEY = "ucch:editor-font-size";

/** Dispatched on `document` when the choice changes, with the new size as `detail`. */
export const EDITOR_FONT_SIZE_EVENT = "ucch:editor-font-size";

export const EDITOR_FONT_SIZE = fontSizePreference({
  defaultSize: DEFAULT_EDITOR_FONT_SIZE,
  min: MIN_EDITOR_FONT_SIZE,
  max: MAX_EDITOR_FONT_SIZE,
  storageKey: EDITOR_FONT_SIZE_STORAGE_KEY,
  event: EDITOR_FONT_SIZE_EVENT,
});

export const parseEditorFontSize = EDITOR_FONT_SIZE.parse;
export const readEditorFontSize = EDITOR_FONT_SIZE.read;
export const writeEditorFontSize = EDITOR_FONT_SIZE.write;
export const watchEditorFontSize = EDITOR_FONT_SIZE.watch;
