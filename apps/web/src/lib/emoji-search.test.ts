import { describe, expect, it } from "vitest";
import { EMOJI, randomEmoji, searchEmoji } from "./emoji-search";

describe("EMOJI", () => {
  it("fits the icon column and lists each glyph once", () => {
    const chars = new Set<string>();
    for (const entry of EMOJI) {
      expect(entry.char.length).toBeLessThanOrEqual(16);
      expect(chars.has(entry.char), `${entry.char} twice`).toBe(false);
      chars.add(entry.char);
      expect(entry.keywords.length).toBeGreaterThan(0);
    }
    expect(EMOJI.length).toBeGreaterThan(200);
  });
});

describe("searchEmoji", () => {
  it("lists everything for nothing", () => {
    expect(searchEmoji("")).toHaveLength(EMOJI.length);
  });
  it("ranks a name before a keyword", () => {
    const [first] = searchEmoji("light");
    expect(first?.name).toBe("light bulb");
    expect(searchEmoji("idea")[0]?.char).toBe("💡");
    expect(searchEmoji("rocket")[0]?.char).toBe("🚀");
  });
  it("finds nothing for nonsense", () => {
    expect(searchEmoji("zzzzqq")).toEqual([]);
  });
});

describe("randomEmoji", () => {
  it("picks from the list", () => {
    expect(EMOJI.some((e) => e.char === randomEmoji(() => 0))).toBe(true);
    expect(EMOJI.some((e) => e.char === randomEmoji(() => 0.999))).toBe(true);
  });
});
