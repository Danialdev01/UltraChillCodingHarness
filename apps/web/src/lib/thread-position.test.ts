import { describe, expect, it } from "vitest";
import { atBottom, BOTTOM_SLACK, promptNeighbours, visionWarning } from "./thread-position.js";

describe("being at the bottom of the thread", () => {
  it("is exact when the box is on its floor", () => {
    expect(atBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 600 })).toBe(true);
  });

  it("forgives a smooth scroll settling a little short", () => {
    expect(
      atBottom({ scrollTop: 900 - BOTTOM_SLACK, scrollHeight: 1500, clientHeight: 600 }),
    ).toBe(true);
  });

  it("is false once the reader has scrolled up into the thread", () => {
    expect(atBottom({ scrollTop: 100, scrollHeight: 1500, clientHeight: 600 })).toBe(false);
  });

  it("is true for a thread that does not scroll at all", () => {
    expect(atBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
  });
});

describe("walking between prompts", () => {
  const thread = [
    { role: "user" },
    { role: "assistant" },
    { role: "user" },
    { role: "assistant" },
    { role: "user" },
  ];

  it("skips the replies and points at the prompts either side", () => {
    const map = promptNeighbours(thread);
    expect(map.get(0)).toEqual({ previous: null, next: 2 });
    expect(map.get(2)).toEqual({ previous: 0, next: 4 });
    expect(map.get(4)).toEqual({ previous: 2, next: null });
  });

  it("has nothing to say about replies", () => {
    expect(promptNeighbours(thread).has(1)).toBe(false);
  });

  it("gives a lone prompt nowhere to go", () => {
    expect(promptNeighbours([{ role: "user" }]).get(0)).toEqual({ previous: null, next: null });
  });
});

describe("warning about pictures a model cannot see", () => {
  const blind = { name: "Text-Only 1", images: false };
  const sighted = { name: "Looker 2", images: true };

  it("says nothing without pictures", () => {
    expect(visionWarning(0, blind)).toBeNull();
  });

  it("says nothing for a model with vision", () => {
    expect(visionWarning(2, sighted)).toBeNull();
  });

  it("does not refuse a model the catalogue no longer lists", () => {
    expect(visionWarning(1, undefined)).toBeNull();
  });

  it("names the model and counts the pictures", () => {
    expect(visionWarning(1, blind)).toMatch(/Text-Only 1 can't see images.*the picture\./);
    expect(visionWarning(3, blind)).toMatch(/the pictures\./);
  });
});
