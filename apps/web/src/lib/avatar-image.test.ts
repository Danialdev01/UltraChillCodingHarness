import { describe, expect, it } from "vitest";
import { AVATAR_SIZE } from "@ucch/protocol";
import { centreCrop, targetSize } from "./avatar-image.js";

describe("cropping to a square", () => {
  it("takes the middle of a landscape photograph", () => {
    // A face in a portrait photograph is near the middle, which is why this
    // crop is right often enough not to need a UI.
    expect(centreCrop(4000, 3000)).toEqual({ x: 500, y: 0, size: 3000 });
  });

  it("takes the middle of a portrait one", () => {
    expect(centreCrop(1080, 1920)).toEqual({ x: 0, y: 420, size: 1080 });
  });

  it("leaves a square alone", () => {
    expect(centreCrop(512, 512)).toEqual({ x: 0, y: 0, size: 512 });
  });

  it("handles an odd difference without losing a pixel to rounding", () => {
    const crop = centreCrop(101, 100);
    expect(crop.size).toBe(100);
    expect(crop.x).toBe(0.5);
  });
});

describe("choosing the size to draw at", () => {
  it("shrinks a large source to the avatar size", () => {
    expect(targetSize(3000)).toBe(AVATAR_SIZE);
  });

  it("never upscales", () => {
    // Four times the bytes for a blurrier picture than the file already was.
    expect(targetSize(64)).toBe(64);
    expect(targetSize(AVATAR_SIZE)).toBe(AVATAR_SIZE);
  });

  it("always produces a drawable canvas", () => {
    expect(targetSize(0)).toBe(1);
    expect(targetSize(0.4)).toBe(1);
  });
});
