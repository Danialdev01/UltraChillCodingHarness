import { describe, expect, it } from "vitest";
import {
  AVATAR_TYPES,
  decodedLength,
  isAvatarDataUrl,
  MAX_AVATAR_BYTES,
} from "./avatar.js";

/** A data URL of `bytes` decoded length, in the given type. */
const dataUrl = (bytes: number, type = "image/webp") =>
  `data:${type};base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;

describe("what may be stored as an avatar", () => {
  it("accepts the formats the browser encodes to", () => {
    for (const type of AVATAR_TYPES) {
      expect(isAvatarDataUrl(dataUrl(1024, type)), type).toBe(true);
    }
  });

  it("refuses anything that is not base64 image data", () => {
    // This value goes straight into an `img src`, so a URL that would leak a
    // request to another host must never survive the check.
    expect(isAvatarDataUrl("https://example.com/me.png")).toBe(false);
    expect(isAvatarDataUrl("//evil.example/me.png")).toBe(false);
    expect(isAvatarDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });

  it("refuses SVG, whatever it is wrapped in", () => {
    // An SVG is a document that can carry script, and an avatar is rendered
    // inline in the app's own origin.
    expect(isAvatarDataUrl(dataUrl(64, "image/svg+xml"))).toBe(false);
  });

  it("refuses a payload that is not actually base64", () => {
    expect(isAvatarDataUrl("data:image/png;base64,not base64!")).toBe(false);
    expect(isAvatarDataUrl("data:image/png,rawbytes")).toBe(false);
  });

  it("refuses anything past the ceiling", () => {
    expect(isAvatarDataUrl(dataUrl(MAX_AVATAR_BYTES - 16))).toBe(true);
    expect(isAvatarDataUrl(dataUrl(MAX_AVATAR_BYTES + 1024))).toBe(false);
  });

  it("is anchored, so nothing can be smuggled either side of it", () => {
    const good = dataUrl(64);
    expect(isAvatarDataUrl(` ${good}`)).toBe(false);
    expect(isAvatarDataUrl(`${good}" onerror="alert(1)`)).toBe(false);
    expect(isAvatarDataUrl(`javascript:0;${good}`)).toBe(false);
  });
});

describe("measuring base64 without decoding it", () => {
  it("counts the bytes the payload would produce", () => {
    // The point is to reject something enormous before allocating it.
    expect(decodedLength("QUJD")).toBe(3);
    expect(decodedLength("QUJDRA==")).toBe(4);
    expect(decodedLength("QUJDREU=")).toBe(5);
    expect(decodedLength("")).toBe(0);
  });
});
