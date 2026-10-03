import { describe, expect, it } from "vitest";
import { movableInto } from "./file-drop";

describe("movableInto", () => {
  it("moves a file into another folder", () => {
    expect(movableInto(["src/a.ts"], "lib")).toEqual(["src/a.ts"]);
  });
  it("moves into and out of the root", () => {
    expect(movableInto(["a.ts"], "src")).toEqual(["a.ts"]);
    expect(movableInto(["src/a.ts"], "")).toEqual(["src/a.ts"]);
  });
  it("is a no-op where the path already lives", () => {
    expect(movableInto(["src/a.ts"], "src")).toEqual([]);
    expect(movableInto(["a.ts"], "")).toEqual([]);
  });
  it("refuses a folder into itself or its own subtree", () => {
    expect(movableInto(["src"], "src")).toEqual([]);
    expect(movableInto(["src"], "src/inner")).toEqual([]);
    // A sibling whose name merely starts the same is fine.
    expect(movableInto(["src"], "srcx")).toEqual(["src"]);
  });
  it("collapses a nested selection to its outermost paths", () => {
    expect(movableInto(["src", "src/a.ts", "src/b/c.ts", "other.ts"], "lib")).toEqual([
      "src",
      "other.ts",
    ]);
  });
  it("keeps the movable part of a mixed selection", () => {
    expect(movableInto(["lib/x.ts", "src/a.ts"], "lib")).toEqual(["src/a.ts"]);
  });
});
