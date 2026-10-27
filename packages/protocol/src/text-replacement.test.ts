import { describe, expect, it } from "vitest";
import { replacement } from "./text-replacement.js";

const apply = (text: string, r: { from: number; to: number; insert: string }) =>
  text.slice(0, r.from) + r.insert + text.slice(r.to);

describe("the smallest edit between two texts", () => {
  it("is nothing when they match", () => {
    expect(replacement("abc", "abc")).toBeNull();
  });

  it("touches only the middle that differs", () => {
    const r = replacement("const a = 1\nconst b = 2\n", "const a = 1\nconst b = 3\n")!;
    expect(r).toEqual({ from: 22, to: 23, insert: "3" });
  });

  it("handles a pure insertion and a pure deletion", () => {
    expect(replacement("ab", "axb")).toEqual({ from: 1, to: 1, insert: "x" });
    expect(replacement("axb", "ab")).toEqual({ from: 1, to: 2, insert: "" });
  });

  it("does not let the prefix and suffix overlap", () => {
    // "aa" -> "aaa": the prefix eats both a's, so the suffix must not.
    expect(apply("aa", replacement("aa", "aaa")!)).toBe("aaa");
    expect(apply("aaa", replacement("aaa", "aa")!)).toBe("aa");
  });

  it("round-trips arbitrary pairs", () => {
    const pairs: [string, string][] = [
      ["", "hello"],
      ["hello", ""],
      ["hello world", "hello brave new world"],
      ["x\ny\nz", "x\nz"],
      ["same start, old end", "same start, new end"],
    ];
    for (const [a, b] of pairs) expect(apply(a, replacement(a, b)!)).toBe(b);
  });
});
