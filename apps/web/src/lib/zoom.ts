/**
 * The arithmetic behind a pan-and-zoom viewport.
 *
 * Kept apart from the component because this is the part that is easy to get
 * subtly wrong and impossible to eyeball: zooming about a point, and keeping
 * the content from being dragged off into space. Both have exact properties a
 * test can hold them to -- the point under the cursor does not move, and the
 * content's edge never crosses the viewport's -- which is worth far more than
 * dragging an image around and deciding it feels right.
 *
 * The model is one transform, `translate(x, y) scale(s)` with the origin at
 * the top left. A content point `c` therefore lands on screen at `c * s + v`,
 * and a screen point `p` maps back to `(p - v) / s`. Every function here is
 * that pair of formulas rearranged.
 */

export interface View {
  /** Pixels of screen per pixel of content. 1 is actual size. */
  scale: number;
  /** Where the content's top-left corner sits in the viewport. */
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** How far the scale may travel, derived from the content and the viewport. */
export interface Limits {
  min: number;
  max: number;
}

/**
 * The scale at which the content just fits, never magnifying past actual size.
 *
 * The `min(1, …)` is what stops a 16px favicon opening as a blurry wall: an
 * image smaller than the pane is shown at its own size, and the reader zooms
 * in if they want to.
 */
export function fitScale(content: Size, viewport: Size): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(1, viewport.width / content.width, viewport.height / content.height);
}

/**
 * How far the scale may travel.
 *
 * The floor is the fitting scale rather than something smaller: zooming out
 * past "the whole thing is visible" only produces a small picture adrift in a
 * large empty pane, and every step of it has to be undone to get back. The
 * ceiling is generous because inspecting one pixel of an icon is a real
 * reason to open an image in a code harness.
 */
export function limitsFor(content: Size, viewport: Size): Limits {
  const fit = fitScale(content, viewport);
  return { min: fit, max: Math.max(8, fit * 32) };
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Puts the content in the middle of the viewport at a given scale.
 *
 * Also the answer for the axis where the content is smaller than the pane,
 * which is why `clampView` calls the same arithmetic rather than repeating it.
 */
export function centerView(content: Size, viewport: Size, scale: number): View {
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/** The view a file opens in: fitted, and centred. */
export function fitView(content: Size, viewport: Size): View {
  return centerView(content, viewport, fitScale(content, viewport));
}

/**
 * Zooms about a fixed point, in viewport coordinates.
 *
 * The whole feel of a zoom is this one property: whatever is under the cursor
 * -- or under the middle of a pinch -- is still under it afterwards. Zooming
 * about the centre instead makes the thing you are looking at slide away
 * exactly when you are trying to look closer.
 *
 * From `p = c * s + v`, the content point under the focal stays put when
 * `v' = p - (p - v) * s'/s`. The scale is clamped first, so the translation
 * is computed from the scale actually applied and the focal stays fixed even
 * at the ends of the range.
 */
export function zoomAbout(view: View, focal: Point, factor: number, limits: Limits): View {
  const scale = clamp(view.scale * factor, limits.min, limits.max);
  const applied = scale / view.scale;
  return {
    scale,
    x: focal.x - (focal.x - view.x) * applied,
    y: focal.y - (focal.y - view.y) * applied,
  };
}

/**
 * Keeps the content anchored to the viewport.
 *
 * Per axis, because an image can be wider than the pane and shorter than it
 * at the same time. Larger than the viewport: the translation is bounded so
 * neither edge can be dragged inside the pane, which is what stops the
 * picture being flung into a corner and lost. Smaller: it is centred, and
 * cannot be dragged at all.
 */
export function clampView(view: View, content: Size, viewport: Size): View {
  const axis = (offset: number, contentLength: number, viewportLength: number) => {
    const scaled = contentLength * view.scale;
    if (scaled <= viewportLength) return (viewportLength - scaled) / 2;
    return clamp(offset, viewportLength - scaled, 0);
  };

  return {
    scale: view.scale,
    x: axis(view.x, content.width, viewport.width),
    y: axis(view.y, content.height, viewport.height),
  };
}

/** Zoom about a point, then re-anchor. The pairing every gesture wants. */
export function zoomClamped(
  view: View,
  focal: Point,
  factor: number,
  content: Size,
  viewport: Size,
): View {
  return clampView(zoomAbout(view, focal, factor, limitsFor(content, viewport)), content, viewport);
}

/**
 * A wheel event's delta in pixels, whatever unit it arrived in.
 *
 * Firefox reports lines, and a page at a time when a wheel is configured
 * that way; Chrome and Safari report pixels. Without this a single notch
 * zooms three times as far on one browser as the other.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 16; // DOM_DELTA_LINE, ~one line
  if (deltaMode === 2) return deltaY * 100; // DOM_DELTA_PAGE
  return deltaY;
}

/**
 * The zoom factor for one wheel event.
 *
 * Exponential rather than additive, so a step in and a step back out land
 * exactly where they started and zooming feels the same at every scale --
 * adding a constant is imperceptible at 8x and enormous at 0.1x.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set, which is the
 * only way a browser reports one. Its deltas are far finer than a mouse
 * notch, so it gets a gentler constant; a real Ctrl+wheel from a mouse is
 * indistinguishable and lands here too, which is the behaviour people expect
 * from it anyway.
 */
export function wheelZoomFactor(delta: number, pinch: boolean): number {
  return Math.exp(-delta * (pinch ? 0.01 : 0.0025));
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/** One press of the zoom buttons, or of `+` and `-`. */
export const STEP_IN = 1.25;
export const STEP_OUT = 1 / STEP_IN;

/** What a double-click zooms to, when it is not zooming back out to fit. */
export const DOUBLE_CLICK_SCALE = 2;

/**
 * Whether the content is bigger than the pane, and can therefore be dragged.
 *
 * Drives the cursor: a grab hand over something that cannot move is a
 * promise the viewer does not keep.
 */
export function isPannable(view: View, content: Size, viewport: Size): boolean {
  return (
    content.width * view.scale > viewport.width + 0.5 ||
    content.height * view.scale > viewport.height + 0.5
  );
}
