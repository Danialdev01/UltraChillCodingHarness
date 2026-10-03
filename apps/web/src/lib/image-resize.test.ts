import { describe, expect, it } from "vitest";
import { clampWidth, snapWidth, widthFromDrag } from "./image-resize";

describe("clampWidth", () => {
  it("keeps widths between the bounds, rounded", () => {
    expect(clampWidth(5)).toBe(20);
    expect(clampWidth(140)).toBe(100);
    expect(clampWidth(42.4)).toBe(42);
    expect(clampWidth(Number.NaN)).toBe(100);
  });
});

describe("snapWidth", () => {
  it("snaps within the threshold and not outside it", () => {
    expect(snapWidth(51)).toBe(50);
    expect(snapWidth(48)).toBe(50);
    expect(snapWidth(45)).toBe(45);
    expect(snapWidth(98)).toBe(100);
  });
});

describe("widthFromDrag", () => {
  it("grows a centred image twice as fast as the pointer", () => {
    expect(
      widthFromDrag({ startPercent: 50, deltaPx: 50, containerPx: 1000, align: "center", edge: "right" }),
    ).toBe(60);
    expect(
      widthFromDrag({ startPercent: 50, deltaPx: -50, containerPx: 1000, align: "center", edge: "left" }),
    ).toBe(60);
  });
  it("grows a side-aligned image by the pointer alone", () => {
    expect(
      widthFromDrag({ startPercent: 50, deltaPx: 100, containerPx: 1000, align: "left", edge: "right" }),
    ).toBe(60);
    expect(
      widthFromDrag({ startPercent: 50, deltaPx: -100, containerPx: 1000, align: "right", edge: "left" }),
    ).toBe(60);
  });
  it("shrinks when dragged inward and clamps", () => {
    expect(
      widthFromDrag({ startPercent: 30, deltaPx: -500, containerPx: 1000, align: "left", edge: "right" }),
    ).toBe(20);
  });
  it("keeps the width when the container has no size", () => {
    expect(
      widthFromDrag({ startPercent: 40, deltaPx: 30, containerPx: 0, align: "left", edge: "right" }),
    ).toBe(40);
  });
});
