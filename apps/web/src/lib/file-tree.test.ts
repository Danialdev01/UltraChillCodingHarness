import { describe, expect, it } from "vitest"

import { flattenTree } from "./file-tree"

describe("flattenTree", () => {
  it("lists files with their full path and leaves folders out", () => {
    expect(
      flattenTree([
        { name: "README.md" },
        { name: "src", children: [{ name: "index.ts" }, { name: "lib", children: [{ name: "a.ts" }] }] },
        { name: "empty", children: [] },
      ]),
    ).toEqual(["README.md", "src/index.ts", "src/lib/a.ts"])
  })

  it("is empty for an empty tree", () => {
    expect(flattenTree([])).toEqual([])
  })
})
