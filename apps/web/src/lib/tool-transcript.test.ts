import { describe, expect, it } from "vitest";

import { LINE_DIFF_CAP, classifyTool, diffStats, lineDiff, parseShellResult, trimContext } from "./tool-transcript";

describe("classifyTool", () => {
  it("reads a native shell call", () => {
    expect(classifyTool({ name: "bash", input: { command: "ls -la" } })).toEqual({ kind: "shell", command: "ls -la" });
  });

  it("unwraps a bash -lc argv", () => {
    expect(classifyTool({ name: "exec_command", input: { command: ["bash", "-lc", "pnpm test"] } })).toEqual({
      kind: "shell",
      command: "pnpm test",
    });
  });

  it("reads native and Claude Code edits alike", () => {
    const want = { kind: "edit", path: "a.ts", edits: [{ old: "x", new: "y" }] };
    expect(classifyTool({ name: "edit_file", input: { path: "a.ts", old_string: "x", new_string: "y" } })).toEqual(want);
    expect(classifyTool({ name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } })).toEqual(want);
  });

  it("reads every edit of a MultiEdit", () => {
    const view = classifyTool({
      name: "MultiEdit",
      input: { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    });
    expect(view).toEqual({ kind: "edit", path: "a.ts", edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }] });
  });

  it("takes OMP's patch-shaped edit as a patch", () => {
    expect(classifyTool({ name: "edit_file", input: { input: "[a.ts#abcd]\n+x" } })).toEqual({
      kind: "patch",
      path: null,
      patch: "[a.ts#abcd]\n+x",
    });
  });

  it("reads writes", () => {
    expect(classifyTool({ name: "Write", input: { file_path: "b.md", content: "hi" } })).toEqual({
      kind: "write",
      path: "b.md",
      content: "hi",
    });
    expect(classifyTool({ name: "write_file", input: { path: "b.md", content: "hi" } }).kind).toBe("write");
  });

  it("reads Codex file changes", () => {
    expect(classifyTool({ name: "file_change", input: { changes: [{ path: "a", kind: "add" }] } })).toEqual({
      kind: "files",
      changes: [{ path: "a", change: "add" }],
    });
  });

  it("reads lookups as one line", () => {
    expect(classifyTool({ name: "Grep", input: { pattern: "foo" } })).toEqual({ kind: "read", verb: "Grep", label: "foo" });
    expect(classifyTool({ name: "read_file", input: { path: "x" } })).toEqual({ kind: "read", verb: "Read", label: "x" });
  });

  it("leaves anything else as other", () => {
    expect(classifyTool({ name: "mystery", input: { a: 1 } })).toEqual({ kind: "other" });
    expect(classifyTool({ name: "Edit", input: {} })).toEqual({ kind: "other" });
  });
});

describe("parseShellResult", () => {
  it("splits off the native exit code line", () => {
    expect(parseShellResult("hello\nworld\nexit code: 0")).toEqual({ output: "hello\nworld", exitCode: 0 });
    expect(parseShellResult("boom\nstderr:\nbad\nexit code: 2\n")).toEqual({ output: "boom\nstderr:\nbad", exitCode: 2 });
  });

  it("reads (no output) as empty", () => {
    expect(parseShellResult("(no output)\nexit code: 1")).toEqual({ output: "", exitCode: 1 });
  });

  it("gives null with no exit line", () => {
    expect(parseShellResult("just output\n")).toEqual({ output: "just output", exitCode: null });
  });
});

describe("lineDiff", () => {
  it("is all context for identical text", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === "context")).toBe(true);
  });

  it("is all added from nothing, all removed to nothing", () => {
    expect(lineDiff("", "a\nb").map((l) => l.kind)).toEqual(["add", "add"]);
    expect(lineDiff("a\nb\n", "").map((l) => l.kind)).toEqual(["del", "del"]);
  });

  it("finds a change in the middle, removals first", () => {
    const lines = lineDiff("a\nb\nc", "a\nB\nc");
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["context:a", "del:b", "add:B", "context:c"]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("falls back to remove-then-add past the cap", () => {
    const big = Array.from({ length: LINE_DIFF_CAP + 1 }, (_, i) => String(i)).join("\n");
    const lines = lineDiff(big, big);
    expect(diffStats(lines)).toEqual({ added: LINE_DIFF_CAP + 1, removed: LINE_DIFF_CAP + 1 });
  });
});

describe("trimContext", () => {
  it("keeps context around a change and folds the rest into gaps", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const trimmed = trimContext(lineDiff(before, after), 2);
    expect(trimmed[0]).toEqual({ kind: "gap", count: 8 });
    expect(trimmed.at(-1)).toEqual({ kind: "gap", count: 7 });
    expect(trimmed.filter((l) => l.kind !== "gap")).toHaveLength(6);
  });
});
