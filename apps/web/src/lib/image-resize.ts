/**
 * The arithmetic behind dragging an image's edge.
 *
 * Widths are percentages of the page column, so a page reads the same on
 * every screen. Snapping to the usual fractions is what makes two images
 * line up without a ruler.
 */

export type ImageAlign = "left" | "center" | "right";

export const IMAGE_MIN_PERCENT = 20;
export const IMAGE_MAX_PERCENT = 100;
export const IMAGE_SNAPS: readonly number[] = [25, 33, 50, 66, 75, 100];

export function clampWidth(percent: number): number {
  if (!Number.isFinite(percent)) return IMAGE_MAX_PERCENT;
  return Math.min(IMAGE_MAX_PERCENT, Math.max(IMAGE_MIN_PERCENT, Math.round(percent)));
}

/** The nearest usual fraction when close enough to one, else the width as is. */
export function snapWidth(
  percent: number,
  snaps: readonly number[] = IMAGE_SNAPS,
  threshold = 3,
): number {
  const width = clampWidth(percent);
  for (const snap of snaps) if (Math.abs(width - snap) <= threshold) return snap;
  return width;
}

/**
 * The width after dragging one edge by `deltaPx`.
 *
 * A centred image keeps its centre, so pulling one edge out moves the other
 * edge out as much: the delta counts twice. An image against one side only
 * grows from its free edge.
 */
export function widthFromDrag(input: {
  startPercent: number;
  deltaPx: number;
  containerPx: number;
  align: ImageAlign;
  edge: "left" | "right";
}): number {
  const { startPercent, deltaPx, containerPx, align, edge } = input;
  if (containerPx <= 0) return clampWidth(startPercent);
  const outward = edge === "right" ? deltaPx : -deltaPx;
  const factor = align === "center" ? 2 : 1;
  return clampWidth(startPercent + ((outward * factor) / containerPx) * 100);
}
