import { describe, expect, it } from "vitest"

import { parseConflict, parsePatch, sidesOf } from "./git-diff"

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function main() {
 const a = 1
-const b = 2
+const b = 3
 const c = 4
 return a
@@ -10,2 +10,3 @@
 x
+y
 z
`

describe("parsePatch", () => {
  it("reads paths, hunks and numbers both sides", () => {
    const [file] = parsePatch(MODIFIED)
    expect(file).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts" })
    expect(file!.hunks).toHaveLength(2)
    const [first, second] = file!.hunks
    expect(first).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, header: "@@ -1,4 +1,4 @@ function main() {" })
    expect(first!.lines).toEqual([
      { kind: "context", text: "const a = 1", oldNo: 1, newNo: 1 },
      { kind: "del", text: "const b = 2", oldNo: 2 },
      { kind: "add", text: "const b = 3", newNo: 2 },
      { kind: "context", text: "const c = 4", oldNo: 3, newNo: 3 },
      { kind: "context", text: "return a", oldNo: 4, newNo: 4 },
    ])
    expect(second!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 10, 10],
      ["add", undefined, 11],
      ["context", 11, 12],
    ])
  })

  it("marks a new file and a deleted file", () => {
    const added = parsePatch(`diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n`)
    expect(added[0]).toMatchObject({ oldPath: null, newPath: "new.ts" })
    expect(added[0]!.hunks[0]!.lines).toEqual([{ kind: "add", text: "hello", newNo: 1 }])

    const deleted = parsePatch(`diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n`)
    expect(deleted[0]).toMatchObject({ oldPath: "old.ts", newPath: null })
  })

  it("reads a rename with no content change", () => {
    const [file] = parsePatch(`diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n`)
    expect(file).toEqual({ oldPath: "a.ts", newPath: "b.ts", hunks: [] })
  })

  it("attaches a missing trailing newline to the line before it", () => {
    const [file] = parsePatch(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-one\n\\ No newline at end of file\n+one\n`)
    expect(file!.hunks[0]!.lines).toEqual([
      { kind: "del", text: "one", oldNo: 1, noNewline: true },
      { kind: "add", text: "one", newNo: 1 },
    ])
  })

  it("treats a blank line inside a hunk as context", () => {
    const [file] = parsePatch(`--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n`)
    expect(file!.hunks[0]!.lines[1]).toEqual({ kind: "context", text: "", oldNo: 2, newNo: 2 })
  })

  it("handles more than one file", () => {
    const files = parsePatch(MODIFIED + MODIFIED.replace(/src\/a\.ts/g, "src/b.ts"))
    expect(files.map((f) => f.newPath)).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([])
  })
})

describe("sidesOf", () => {
  it("rebuilds each side and maps line numbers to indexes", () => {
    const [file] = parsePatch(MODIFIED)
    const sides = sidesOf(file!)
    expect(sides.oldText.split("\n")).toEqual(["const a = 1", "const b = 2", "const c = 4", "return a", "x", "z"])
    expect(sides.newText.split("\n")).toEqual(["const a = 1", "const b = 3", "const c = 4", "return a", "x", "y", "z"])
    expect(sides.oldIndex.get(2)).toBe(1)
    expect(sides.newIndex.get(11)).toBe(5)
    expect(sides.oldIndex.get(11)).toBe(5)
  })
})

describe("parseConflict", () => {
  it("labels each side of a conflict block", () => {
    const { lines, conflicts } = parseConflict(
      ["before", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> other", "after"].join("\n") + "\n",
    )
    expect(conflicts).toBe(1)
    expect(lines.map((l) => l.side)).toEqual(["plain", "marker", "ours", "marker", "theirs", "marker", "plain"])
    expect(lines[6]).toEqual({ text: "after", side: "plain", no: 7 })
  })

  it("understands diff3 markers", () => {
    const { lines } = parseConflict(["<<<<<<< a", "o", "||||||| base", "b", "=======", "t", ">>>>>>> c"].join("\n"))
    expect(lines.map((l) => l.side)).toEqual(["marker", "ours", "marker", "base", "marker", "theirs", "marker"])
  })

  it("leaves a lone ======= outside a block alone", () => {
    const { lines, conflicts } = parseConflict("=======\ntext")
    expect(conflicts).toBe(0)
    expect(lines[0]!.side).toBe("plain")
  })
})
