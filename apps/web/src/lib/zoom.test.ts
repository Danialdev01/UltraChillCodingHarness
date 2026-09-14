import { describe, expect, it } from "vitest";
import {
  centerView,
  clampView,
  distance,
  fitScale,
  fitView,
  isPannable,
  limitsFor,
  midpoint,
  normalizeWheelDelta,
  wheelZoomFactor,
  zoomAbout,
  zoomClamped,
  type Size,
  type View,
} from "./zoom.js";

const PANE: Size = { width: 800, height: 600 };
/** Wider and taller than the pane: the case where panning exists at all. */
const PHOTO: Size = { width: 4000, height: 3000 };
/** Smaller than the pane in both axes. */
const ICON: Size = { width: 16, height: 16 };

/** Where a content point lands on screen under a view. */
const project = (view: View, x: number, y: number) => ({
  x: x * view.scale + view.x,
  y: y * view.scale + view.y,
});

/** What content point is under a screen point. */
const unproject = (view: View, x: number, y: number) => ({
  x: (x - view.x) / view.scale,
  y: (y - view.y) / view.scale,
});

describe("fitting", () => {
  it("shrinks something larger than the pane until it fits", () => {
    expect(fitScale(PHOTO, PANE)).toBeCloseTo(0.2, 5);
    const fitted = fitView(PHOTO, PANE);
    expect(fitted.scale * PHOTO.width).toBeCloseTo(800, 5);
    expect(fitted.scale * PHOTO.height).toBeCloseTo(600, 5);
  });

  it("leaves something smaller at its own size rather than blowing it up", () => {
    // A 16px favicon stretched across 800px is a blurry wall, and not what
    // opening it was for.
    expect(fitScale(ICON, PANE)).toBe(1);
  });

  it("centres what it fits", () => {
    const view = fitView(ICON, PANE);
    expect(view.x).toBeCloseTo((800 - 16) / 2, 5);
    expect(view.y).toBeCloseTo((600 - 16) / 2, 5);
  });

  it("survives a pane or an image with no size yet", () => {
    // Both are ordinary for a frame or two: the observer has not reported,
    // or the image has not loaded.
    expect(fitScale(PHOTO, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, PANE)).toBe(1);
  });
});

describe("zooming about a point", () => {
  it("keeps whatever is under that point exactly where it was", () => {
    // The property the whole gesture rests on. If it fails, the thing you
    // are zooming towards slides away as you zoom.
    const limits = limitsFor(PHOTO, PANE);
    const focal = { x: 620, y: 130 };
    const before = fitView(PHOTO, PANE);
    const under = unproject(before, focal.x, focal.y);

    for (const factor of [1.25, 0.8, 3, 1 / 3, 1.001]) {
      const after = zoomAbout(before, focal, factor, limits);
      const now = project(after, under.x, under.y);
      expect(now.x).toBeCloseTo(focal.x, 6);
      expect(now.y).toBeCloseTo(focal.y, 6);
    }
  });

  it("keeps it fixed even when the scale hits a limit", () => {
    // The translation must follow the scale that was *applied*, not the one
    // that was asked for -- otherwise the image lurches at each end.
    const limits = limitsFor(PHOTO, PANE);
    const focal = { x: 100, y: 500 };
    const view = { scale: limits.max / 1.2, x: -40, y: -90 };
    const under = unproject(view, focal.x, focal.y);

    const after = zoomAbout(view, focal, 1000, limits);
    expect(after.scale).toBe(limits.max);
    expect(project(after, under.x, under.y).x).toBeCloseTo(focal.x, 6);
    expect(project(after, under.x, under.y).y).toBeCloseTo(focal.y, 6);
  });

  it("comes back to where it started after equal and opposite steps", () => {
    const limits = limitsFor(PHOTO, PANE);
    const focal = { x: 333, y: 222 };
    const start = { scale: 1, x: -100, y: -50 };

    const there = zoomAbout(start, focal, 1.25, limits);
    const back = zoomAbout(there, focal, 1 / 1.25, limits);

    expect(back.scale).toBeCloseTo(start.scale, 9);
    expect(back.x).toBeCloseTo(start.x, 9);
    expect(back.y).toBeCloseTo(start.y, 9);
  });

  it("will not zoom out past fitting, or in past the ceiling", () => {
    const limits = limitsFor(PHOTO, PANE);
    expect(limits.min).toBeCloseTo(fitScale(PHOTO, PANE), 9);

    const out = zoomAbout(fitView(PHOTO, PANE), { x: 0, y: 0 }, 0.001, limits);
    expect(out.scale).toBeCloseTo(limits.min, 9);
    const inward = zoomAbout({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 1e6, limits);
    expect(inward.scale).toBe(limits.max);
  });

  it("lets a small image be magnified well past its own size", () => {
    // 16px of favicon is worth a close look; a ceiling of 1 would make the
    // viewer useless for exactly the files it is most needed on.
    expect(limitsFor(ICON, PANE).max).toBeGreaterThanOrEqual(8);
  });
});

describe("keeping the content anchored", () => {
  it("centres an axis where the content is smaller than the pane", () => {
    const dragged = clampView({ scale: 1, x: -500, y: 900 }, ICON, PANE);
    expect(dragged.x).toBeCloseTo((800 - 16) / 2, 5);
    expect(dragged.y).toBeCloseTo((600 - 16) / 2, 5);
  });

  it("never lets an edge be dragged inside the pane", () => {
    // What stops the picture being flung into a corner and lost.
    const view = { scale: 1, x: 0, y: 0 };
    for (const [x, y] of [
      [5000, 5000],
      [-99_999, -99_999],
      [1, -2],
    ]) {
      const clamped = clampView({ ...view, x: x!, y: y! }, PHOTO, PANE);
      expect(clamped.x).toBeLessThanOrEqual(0);
      expect(clamped.y).toBeLessThanOrEqual(0);
      expect(clamped.x).toBeGreaterThanOrEqual(PANE.width - PHOTO.width);
      expect(clamped.y).toBeGreaterThanOrEqual(PANE.height - PHOTO.height);
    }
  });

  it("handles an image wider than the pane and shorter than it", () => {
    // A banner: pannable sideways, pinned vertically. One rule per axis is
    // the reason this is not a single comparison.
    const banner: Size = { width: 4000, height: 100 };
    const clamped = clampView({ scale: 1, x: -300, y: -300 }, banner, PANE);
    expect(clamped.x).toBe(-300);
    expect(clamped.y).toBeCloseTo((600 - 100) / 2, 5);
  });

  it("leaves a fitted view exactly where fitting put it", () => {
    const fitted = fitView(PHOTO, PANE);
    expect(clampView(fitted, PHOTO, PANE)).toEqual(fitted);
  });

  it("re-anchors after a zoom that would have pushed content off", () => {
    const view = zoomClamped(fitView(PHOTO, PANE), { x: 0, y: 0 }, 4, PHOTO, PANE);
    expect(view.x).toBeLessThanOrEqual(0);
    expect(view.x).toBeGreaterThanOrEqual(PANE.width - PHOTO.width * view.scale);
  });
});

describe("whether there is anything to drag", () => {
  it("is false at fit and true once zoomed in", () => {
    // Drives the grab cursor: offering one over something that cannot move
    // is a promise the viewer does not keep.
    expect(isPannable(fitView(PHOTO, PANE), PHOTO, PANE)).toBe(false);
    expect(isPannable({ scale: 1, x: 0, y: 0 }, PHOTO, PANE)).toBe(true);
    expect(isPannable(fitView(ICON, PANE), ICON, PANE)).toBe(false);
  });
});

describe("wheel input", () => {
  it("puts every browser's units into pixels", () => {
    // Firefox reports lines, and pages when a wheel is configured that way.
    // Untouched, one notch would zoom three times as far there.
    expect(normalizeWheelDelta(100, 0)).toBe(100);
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(100);
  });

  it("zooms in scrolling up and out scrolling down", () => {
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
  });

  it("is exactly reversible, so a scroll back lands where it started", () => {
    expect(wheelZoomFactor(-120, false) * wheelZoomFactor(120, false)).toBeCloseTo(1, 12);
  });

  it("treats a trackpad pinch more gently than a mouse notch", () => {
    // A pinch arrives as a wheel event with ctrlKey and far finer deltas;
    // one constant for both makes one of them unusable.
    expect(wheelZoomFactor(-10, true)).toBeGreaterThan(wheelZoomFactor(-10, false));
  });

  it("never produces a factor that would flip or vanish the image", () => {
    for (const delta of [-10_000, -500, 0, 500, 10_000]) {
      const factor = wheelZoomFactor(delta, false);
      expect(factor).toBeGreaterThan(0);
      expect(Number.isFinite(factor)).toBe(true);
    }
  });
});

describe("two-finger geometry", () => {
  it("measures the spread and the middle of a pinch", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 10 }, { x: 4, y: 0 })).toEqual({ x: 2, y: 5 });
  });

  it("scales by the ratio the fingers moved", () => {
    // Fingers twice as far apart means twice the scale, about their middle.
    const limits = limitsFor(PHOTO, PANE);
    const start = fitView(PHOTO, PANE);
    const a = { x: 300, y: 300 };
    const b = { x: 500, y: 300 };
    const spread = distance(a, b);

    const zoomed = zoomAbout(start, midpoint(a, b), (spread * 2) / spread, limits);
    expect(zoomed.scale).toBeCloseTo(start.scale * 2, 9);
  });
});

describe("centring", () => {
  it("puts the content in the middle at any scale", () => {
    const view = centerView(PHOTO, PANE, 0.1);
    expect(view.x).toBeCloseTo((800 - 400) / 2, 5);
    expect(view.y).toBeCloseTo((600 - 300) / 2, 5);
  });
});
