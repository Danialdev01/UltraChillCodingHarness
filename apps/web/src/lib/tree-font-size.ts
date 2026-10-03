/**
 * The size the file tree sidebar renders at, in CSS pixels: the file name,
 * and the icon beside it, which follows the name so a row never has a large
 * label next to a tiny glyph. See `font-size-preference.ts` for how it is
 * kept and announced.
 */

import { fontSizePreference } from "./font-size-preference";

/** 14px is the sidebar's own `text-sm`, so the default changes nothing. */
export const DEFAULT_TREE_FONT_SIZE = 14;
export const MIN_TREE_FONT_SIZE = 10;
export const MAX_TREE_FONT_SIZE = 24;

export const TREE_FONT_SIZE = fontSizePreference({
  defaultSize: DEFAULT_TREE_FONT_SIZE,
  min: MIN_TREE_FONT_SIZE,
  max: MAX_TREE_FONT_SIZE,
  storageKey: "ucch:tree-font-size",
  event: "ucch:tree-font-size",
});

/**
 * The icon beside a name of `fontSize` pixels: two more, which is the 16px
 * glyph the sidebar draws beside its 14px text.
 */
export function treeIconSize(fontSize: number): number {
  return fontSize + 2;
}

/**
 * The padding inside a row, and the gap between its icon and name, for a
 * name of `fontSize` pixels: the sidebar's 8px at its 14px text, scaled with
 * the text so a small font gets a tight row and a large one room to breathe.
 */
export function treeRowSpacing(fontSize: number): number {
  return Math.round((fontSize * 8) / 14);
}
