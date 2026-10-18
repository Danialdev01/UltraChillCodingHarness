/**
 * The size the file tree sidebar renders at, in CSS pixels: the file name,
 * and every other measure of a row, which follow the name so a large label
 * never sits in a cramped row nor a small one in a sparse one. See
 * `font-size-preference.ts` for how it is kept and announced.
 */

import { fontSizePreference } from "./font-size-preference";

/** 13px is VS Code's explorer, which the tree's density is modelled on. */
export const DEFAULT_TREE_FONT_SIZE = 13;
export const MIN_TREE_FONT_SIZE = 10;
export const MAX_TREE_FONT_SIZE = 24;

export const TREE_FONT_SIZE = fontSizePreference({
  defaultSize: DEFAULT_TREE_FONT_SIZE,
  min: MIN_TREE_FONT_SIZE,
  max: MAX_TREE_FONT_SIZE,
  storageKey: "ucch:tree-font-size",
  event: "ucch:tree-font-size",
});

/** Every measure of a tree row, in whole pixels. */
export interface TreeMetrics {
  /** The row, and its line: no padding above or below. */
  rowHeight: number;
  /** The file or folder icon. */
  iconSize: number;
  /** The column the folder chevron sits in; files keep it empty. */
  chevronBox: number;
  /** The chevron glyph, centred in its column. */
  chevronGlyph: number;
  /** Between the chevron column and the icon. */
  gapChevron: number;
  /** Between the icon and the name. */
  gapLabel: number;
  /** The row's padding at either end. */
  padX: number;
  /** How much further in each level of nesting starts. */
  indent: number;
}

/** The explorer's measures at its 13px default. */
const BASE: TreeMetrics = {
  rowHeight: 22,
  iconSize: 16,
  chevronBox: 16,
  chevronGlyph: 12,
  gapChevron: 2,
  gapLabel: 6,
  padX: 8,
  indent: 8,
};

/**
 * The row for a name of `fontSize` pixels: the explorer's measures at 13px,
 * scaled in proportion at any other size, so a 17px name gets the roomier
 * row the tree had before it was made compact.
 */
export function treeMetrics(fontSize: number): TreeMetrics {
  const scale = fontSize / DEFAULT_TREE_FONT_SIZE;
  const out = {} as TreeMetrics;
  for (const key of Object.keys(BASE) as (keyof TreeMetrics)[]) out[key] = Math.round(BASE[key] * scale);
  // Never a row shorter than its text, whatever the rounding did.
  out.rowHeight = Math.max(out.rowHeight, Math.ceil(fontSize * 1.25));
  return out;
}

/** The metrics as the CSS variables the tree's styles read, set on its root. */
export function treeMetricsStyle(fontSize: number): Record<string, string> {
  const m = treeMetrics(fontSize);
  return {
    "--tree-font-size": `${fontSize}px`,
    "--tree-row-height": `${m.rowHeight}px`,
    "--tree-icon-size": `${m.iconSize}px`,
    "--tree-chevron-size": `${m.chevronBox}px`,
    "--tree-chevron-glyph": `${m.chevronGlyph}px`,
    "--tree-gap-chevron": `${m.gapChevron}px`,
    "--tree-gap-label": `${m.gapLabel}px`,
    "--tree-pad-x": `${m.padX}px`,
    "--tree-indent": `${m.indent}px`,
  };
}
