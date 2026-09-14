import { describe, expect, it } from "vitest";
import { groupByFile, highlight, type SearchMatch } from "./search-api.js";

function match(over: Partial<SearchMatch> = {}): SearchMatch {
  return { path: "src/app.ts", line: 1, text: "const token = 1", ranges: [[6, 11]], ...over };
}

describe("groupByFile", () => {
  it("collects a file's matches under it", () => {
    const groups = groupByFile([
      match({ path: "a.ts", line: 1 }),
      match({ path: "a.ts", line: 9 }),
      match({ path: "b.ts", line: 3 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.path).toBe("a.ts");
    expect(groups[0]!.matches.map((m) => m.line)).toEqual([1, 9]);
    expect(groups[1]!.matches).toHaveLength(1);
  });

  it("keeps the order the matches arrived in", () => {
    // ripgrep's order is roughly directory order, which is the order the tree
    // beside the panel is in; sorting would throw that away.
    const groups = groupByFile([match({ path: "z.ts" }), match({ path: "a.ts" })]);
    expect(groups.map((g) => g.path)).toEqual(["z.ts", "a.ts"]);
  });

  it("starts a new group when a path comes back later", () => {
    const groups = groupByFile([
      match({ path: "a.ts" }),
      match({ path: "b.ts" }),
      match({ path: "a.ts" }),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["a.ts", "b.ts", "a.ts"]);
  });

  it("groups nothing into nothing", () => {
    expect(groupByFile([])).toEqual([]);
  });
});

describe("highlight", () => {
  const text = (segments: Array<{ text: string; match: boolean }>) =>
    segments.map((s) => s.text).join("");

  it("splits a line into the parts that matched and the parts that did not", () => {
    expect(highlight("const token = 1", [[6, 11]])).toEqual([
      { text: "const ", match: false },
      { text: "token", match: true },
      { text: " = 1", match: false },
    ]);
  });

  it("marks every match in the line", () => {
    const segments = highlight("token token", [
      [0, 5],
      [6, 11],
    ]);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["token", "token"]);
  });

  it("trims the indentation and moves the ranges with it", () => {
    // Indented code would otherwise push the match off the right of an 18rem
    // panel, with the highlight landing on the wrong characters.
    const segments = highlight("      const token = 1", [[12, 17]]);
    expect(text(segments)).toBe("const token = 1");
    expect(segments.find((s) => s.match)?.text).toBe("token");
  });

  it("loses no characters, whatever the ranges are", () => {
    for (const ranges of [[], [[0, 5]], [[6, 11]], [[0, 15]]] as Array<Array<[number, number]>>) {
      expect(text(highlight("const token = 1", ranges))).toBe("const token = 1");
    }
  });

  it("ignores a range that runs backwards or lands outside the line", () => {
    // Defensive: a bad range must not produce a negative slice or drop text.
    expect(text(highlight("abc", [[2, 1]]))).toBe("abc");
    expect(text(highlight("abc", [[5, 9]]))).toBe("abc");
  });

  it("ignores a range that overlaps one already taken", () => {
    const segments = highlight("abcdef", [
      [0, 4],
      [2, 5],
    ]);
    expect(text(segments)).toBe("abcdef");
    expect(segments.filter((s) => s.match)).toHaveLength(1);
  });

  it("returns a whitespace-only line as itself", () => {
    expect(highlight("   ", [])).toEqual([]);
  });
});
