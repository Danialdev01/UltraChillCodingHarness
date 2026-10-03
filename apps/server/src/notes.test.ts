import { describe, expect, it } from "vitest";
import { escapeLike, isDescendant, renumber } from "./notes.js";

const rows = [
  { id: "root", parentId: null },
  { id: "a", parentId: "root" },
  { id: "a1", parentId: "a" },
  { id: "a1x", parentId: "a1" },
  { id: "b", parentId: "root" },
];

describe("isDescendant", () => {
  it("finds a page below an ancestor at any depth", () => {
    expect(isDescendant(rows, "a", "a1")).toBe(true);
    expect(isDescendant(rows, "a", "a1x")).toBe(true);
    expect(isDescendant(rows, "root", "a1x")).toBe(true);
  });

  it("is false for siblings, ancestors, and the page itself", () => {
    expect(isDescendant(rows, "a", "b")).toBe(false);
    expect(isDescendant(rows, "a1", "a")).toBe(false);
    expect(isDescendant(rows, "a", "a")).toBe(false);
  });

  it("terminates on a cycle already in the data", () => {
    const cyclic = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(isDescendant(cyclic, "z", "x")).toBe(false);
  });
});

describe("renumber", () => {
  it("places the moved page at the position", () => {
    expect(renumber(["a", "b", "c"], "m", 1)).toEqual(["a", "m", "b", "c"]);
  });

  it("clamps to the ends", () => {
    expect(renumber(["a", "b"], "m", -3)).toEqual(["m", "a", "b"]);
    expect(renumber(["a", "b"], "m", 99)).toEqual(["a", "b", "m"]);
  });

  it("drops a stale copy of the moved page from the siblings", () => {
    expect(renumber(["a", "m", "b"], "m", 2)).toEqual(["a", "b", "m"]);
  });
});

describe("escapeLike", () => {
  it("turns the wildcards into letters", () => {
    expect(escapeLike("100% done_ok")).toBe("100\\% done\\_ok");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });
});
