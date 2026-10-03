import { describe, expect, it } from "vitest";
import { dropZoneAt, resolveNoteDrop } from "./note-drop";
import type { NoteNode } from "./note-tree";

const n = (id: string, parentId: string | null, position = 0): NoteNode => ({
  id,
  parentId,
  title: id,
  icon: null,
  position,
});

// root
//   a (0)
//     a1 (0)
//   b (1)
//   c (2)
const tree = [n("root", null), n("a", "root", 0), n("a1", "a", 0), n("b", "root", 1), n("c", "root", 2)];

describe("dropZoneAt", () => {
  it("reorders at the edges and nests in the middle", () => {
    expect(dropZoneAt(2, 28, { canReorder: true })).toBe("before");
    expect(dropZoneAt(14, 28, { canReorder: true })).toBe("inside");
    expect(dropZoneAt(26, 28, { canReorder: true })).toBe("after");
  });
  it("only nests on a row that cannot be reordered around", () => {
    expect(dropZoneAt(1, 28, { canReorder: false })).toBe("inside");
  });
});

describe("resolveNoteDrop", () => {
  it("places before and after a sibling", () => {
    expect(resolveNoteDrop(tree, "c", "a", "before")).toEqual({ parentId: "root", position: 0 });
    expect(resolveNoteDrop(tree, "a", "c", "after")).toEqual({ parentId: "root", position: 2 });
  });
  it("counts positions without the dragged page", () => {
    // a moves after b: siblings without a are [b, c], so after b is index 1.
    expect(resolveNoteDrop(tree, "a", "b", "after")).toEqual({ parentId: "root", position: 1 });
  });
  it("nests at the end of the target's children", () => {
    expect(resolveNoteDrop(tree, "b", "a", "inside")).toEqual({ parentId: "a", position: 1 });
    expect(resolveNoteDrop(tree, "b", "c", "inside")).toEqual({ parentId: "c", position: 0 });
  });
  it("refuses itself and its own subtree", () => {
    expect(resolveNoteDrop(tree, "a", "a", "inside")).toBeNull();
    expect(resolveNoteDrop(tree, "a", "a1", "inside")).toBeNull();
    expect(resolveNoteDrop(tree, "a", "a1", "before")).toBeNull();
  });
  it("refuses the root as a dragged page or a sibling", () => {
    expect(resolveNoteDrop(tree, "root", "a", "inside")).toBeNull();
    expect(resolveNoteDrop(tree, "a", "root", "before")).toBeNull();
    expect(resolveNoteDrop(tree, "a", "root", "inside")).toEqual({ parentId: "root", position: 2 });
  });
  it("refuses a drop that changes nothing", () => {
    expect(resolveNoteDrop(tree, "b", "a", "after")).toBeNull();
    expect(resolveNoteDrop(tree, "b", "c", "before")).toBeNull();
    expect(resolveNoteDrop(tree, "a1", "a", "inside")).toBeNull();
  });
});
