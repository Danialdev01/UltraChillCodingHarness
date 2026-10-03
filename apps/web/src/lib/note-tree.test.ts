import { describe, expect, it } from "vitest";
import { ancestorsOf, buildNoteTree, childrenOf, findRoot, titleOrUntitled } from "./note-tree";

const n = (id: string, parentId: string | null, position = 0) => ({
  id,
  parentId,
  title: id,
  icon: null,
  position,
});

const notes = [n("b", "root", 1), n("root", null), n("a", "root", 0), n("a2", "a", 1), n("a1", "a", 0)];

describe("note-tree", () => {
  it("finds the root and orders children by position", () => {
    expect(findRoot(notes)?.id).toBe("root");
    expect(childrenOf(notes, "root").map((c) => c.id)).toEqual(["a", "b"]);
    expect(childrenOf(notes, "a").map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("builds the tree from the root down", () => {
    const tree = buildNoteTree(notes)!;
    expect(tree.id).toBe("root");
    expect(tree.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(tree.children[0]!.children.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("is null without a root", () => {
    expect(buildNoteTree([n("x", "gone")])).toBeNull();
  });

  it("walks ancestors root-first", () => {
    expect(ancestorsOf(notes, "a2").map((c) => c.id)).toEqual(["root", "a", "a2"]);
    expect(ancestorsOf(notes, "root").map((c) => c.id)).toEqual(["root"]);
  });

  it("is empty for an orphan or an unknown page", () => {
    expect(ancestorsOf([...notes, n("o", "gone")], "o")).toEqual([]);
    expect(ancestorsOf(notes, "nope")).toEqual([]);
  });

  it("falls back to Untitled", () => {
    expect(titleOrUntitled("  ")).toBe("Untitled");
    expect(titleOrUntitled("Plan")).toBe("Plan");
  });
});
