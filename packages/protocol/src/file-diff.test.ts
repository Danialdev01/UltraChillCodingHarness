import { describe, expect, it } from "vitest";
import { capFileDiffs, diffFromContent, diffFromPatch, diffFromTexts, EVENT_PATCH_CAP, FILE_PATCH_CAP } from "./file-diff.js";

const text = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("diffFromTexts", () => {
  it("numbers a hunk from its place in the file, with context", () => {
    const diff = diffFromTexts({ path: "a", change: "modified" }, text(50), text(50, { 40: "changed" }));
    expect(diff.patch).toBe("@@ -37,7 +37,7 @@\n line 37\n line 38\n line 39\n-line 40\n+changed\n line 41\n line 42\n line 43");
    expect(diff).toMatchObject({ added: 1, removed: 1, truncated: false });
  });

  it("splits edits far apart into hunks", () => {
    const diff = diffFromTexts({ path: "a", change: "modified" }, text(100), text(100, { 5: "x", 90: "y" }));
    expect(diff.patch.match(/^@@/gm)).toHaveLength(2);
    expect(diff.patch).toContain("@@ -87,7 +87,7 @@");
  });

  it("tells a whole file as added or deleted", () => {
    expect(diffFromContent("a", "added", "x\ny\n").patch).toBe("@@ -0,0 +1,2 @@\n+x\n+y");
    expect(diffFromContent("a", "deleted", "x").patch).toBe("@@ -1,1 +0,0 @@\n-x");
    expect(diffFromContent("a", "added", "").patch).toBe("");
  });
});

describe("caps", () => {
  it("drops headers, and cuts a long patch at a line while counting all of it", () => {
    const body = Array.from({ length: 10_000 }, () => "+0123456789").join("\n");
    const diff = diffFromPatch({ path: "a", change: "added" }, `diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1,10000 @@\n${body}\n`);
    expect(diff.added).toBe(10_000);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBeLessThanOrEqual(FILE_PATCH_CAP);
    expect(diff.patch.endsWith("+0123456789")).toBe(true);
    const { files } = capFileDiffs(Array.from({ length: 10 }, () => diff));
    expect(files.reduce((n, f) => n + f.patch.length, 0)).toBeLessThanOrEqual(EVENT_PATCH_CAP);
    expect(capFileDiffs(Array.from({ length: 250 }, () => diff)).omitted).toBe(50);
  });

  it("reads a binary file's patch as empty", () => {
    expect(diffFromPatch({ path: "a", change: "modified" }, "diff --git a/a b/a\nBinary files a/a and b/a differ\n").patch).toBe("");
  });
});
