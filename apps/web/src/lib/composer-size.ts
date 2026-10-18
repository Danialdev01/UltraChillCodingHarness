/**
 * How tall the composer is allowed to grow.
 *
 * A fixed ten-line ceiling is fine on a desktop and wrong on a phone, where
 * ten lines of text plus the controls is most of the screen and the
 * conversation it belongs to is pushed out of sight. The cap is therefore a
 * share of the space the chat actually has, not a constant -- and the space
 * the chat has is its own panel, which on a wide screen is still short when
 * the window is.
 */

/** The composer never collapses below this, however little room there is. */
export const MIN_COMPOSER_LINES = 1;

/** And never grows past it, however much there is. */
export const MAX_COMPOSER_LINES = 10;

/**
 * The share of the chat the composer may occupy before it stops growing.
 *
 * Two fifths leaves the majority to the conversation. Past that the box you
 * are typing in has eaten the thing you are typing about, and scrolling
 * inside the composer is the better trade.
 */
const SHARE_OF_PANEL = 0.4;

/**
 * The line cap for a panel of a given height.
 *
 * Falls back to the maximum while the height is unknown -- a panel is
 * unmeasured for a frame or two after mount, and starting from the desktop
 * behaviour means the composer never visibly shrinks into place.
 */
export function composerMaxLines(panelHeight: number, lineHeight: number): number {
  if (!(panelHeight > 0) || !(lineHeight > 0)) return MAX_COMPOSER_LINES;

  const affordable = Math.floor((panelHeight * SHARE_OF_PANEL) / lineHeight);
  return Math.min(MAX_COMPOSER_LINES, Math.max(MIN_COMPOSER_LINES, affordable));
}
