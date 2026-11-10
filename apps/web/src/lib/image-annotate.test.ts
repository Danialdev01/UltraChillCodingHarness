import { describe, expect, it } from "vitest";
import {
  arrowHead,
  clampRect,
  currentCrop,
  editedName,
  EMPTY_HISTORY,
  isLight,
  isUsableCrop,
  normalizeRect,
  outputType,
  push,
  redo,
  strokeWidths,
  toImagePoint,
  undo,
  type Op,
} from "./image-annotate";

const dot: Op = { kind: "stroke", points: [{ x: 1, y: 1 }], color: "#ff0000", width: 2 };
const crop: Op = { kind: "crop", rect: { x: 10, y: 20, w: 30, h: 40 } };

describe("history", () => {
  it("undoes and redoes in order", () => {
    const h = push(push(EMPTY_HISTORY, dot), crop);
    const back = undo(h);
    expect(back.ops).toEqual([dot]);
    expect(back.undone).toEqual([crop]);
    expect(redo(back)).toEqual(h);
  });

  it("forgets the redo stack when something new is done", () => {
    const h = push(undo(push(EMPTY_HISTORY, dot)), crop);
    expect(h.undone).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("does nothing at either end", () => {
    expect(undo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
    expect(redo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
  });
});

describe("crop", () => {
  it("is the whole image until one is made, then the latest", () => {
    expect(currentCrop([], 100, 50)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    const later: Op = { kind: "crop", rect: { x: 0, y: 0, w: 9, h: 9 } };
    expect(currentCrop([crop, dot, later, dot], 100, 50)).toEqual(later.rect);
  });

  it("normalises a rectangle dragged up and to the left", () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, w: 40, h: 35 });
  });

  it("clamps to the image and whole pixels", () => {
    expect(clampRect({ x: -5.4, y: 10.6, w: 200, h: 20 }, 100, 50)).toEqual({ x: 0, y: 11, w: 100, h: 20 });
    expect(clampRect({ x: 120, y: 60, w: 10, h: 10 }, 100, 50)).toEqual({ x: 100, y: 50, w: 0, h: 0 });
  });

  it("ignores a click-sized crop", () => {
    expect(isUsableCrop({ x: 0, y: 0, w: 3, h: 100 })).toBe(false);
    expect(isUsableCrop({ x: 0, y: 0, w: 8, h: 8 })).toBe(true);
  });
});

describe("toImagePoint", () => {
  it("undoes the CSS scale and the crop offset", () => {
    const box = { left: 100, top: 50, width: 200, height: 100 };
    const viewport = { x: 40, y: 20, w: 400, h: 200 };
    expect(toImagePoint(100, 50, box, viewport)).toEqual({ x: 40, y: 20 });
    expect(toImagePoint(200, 100, box, viewport)).toEqual({ x: 240, y: 120 });
  });
});

describe("arrowHead", () => {
  it("puts both barbs behind the tip, either side of the shaft", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(Math.sign(a.y)).toBe(-Math.sign(b.y));
  });
});

describe("strokeWidths", () => {
  it("grows with the picture", () => {
    expect(strokeWidths(400, 300)).toEqual([2, 3, 6]);
    const [, big] = strokeWidths(3840, 2160);
    expect(big).toBeGreaterThan(20);
  });
});

describe("output", () => {
  it("keeps JPEG and WebP, and turns everything else into PNG", () => {
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/webp")).toBe("image/webp");
    expect(outputType("image/svg+xml")).toBe("image/png");
    expect(outputType("image/gif")).toBe("image/png");
    expect(outputType("")).toBe("image/png");
  });

  it("names the edit after the original, once", () => {
    expect(editedName("shot.png", "image/png")).toBe("shot-edited.png");
    expect(editedName("shot-edited.png", "image/png")).toBe("shot-edited.png");
    expect(editedName("photo.jpeg", "image/jpeg")).toBe("photo-edited.jpg");
    expect(editedName("logo.svg", "image/svg+xml")).toBe("logo-edited.png");
    expect(editedName("noext", "image/png")).toBe("noext-edited.png");
  });
});

describe("isLight", () => {
  it("tells white from red", () => {
    expect(isLight("#ffffff")).toBe(true);
    expect(isLight("#ef4444")).toBe(false);
  });
});
