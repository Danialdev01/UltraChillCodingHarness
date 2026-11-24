import { describe, expect, it } from "vitest";
import { ClaudeNormaliser } from "./claude.js";
import { CodexNormaliser } from "./codex.js";

const ctx = {
  projectId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  workspace: "/w",
};
const diffs = (events: { type: string }[]) => events.filter((e) => e.type === "agent.file_diff");

describe("Claude file diffs", () => {
  const edit = (result: object, isError = false) => {
    const n = new ClaudeNormaliser(ctx as never);
    n.push(JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/w/a.ts" } }] } }));
    return n.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok", is_error: isError }] }, tool_use_result: result }));
  };
  it("keeps the line numbers the CLI computed", () => {
    const structuredPatch = [{ oldStart: 9, oldLines: 2, newStart: 9, newLines: 2, lines: [" a", "-b", "+c"] }];
    expect(diffs(edit({ filePath: "/w/a.ts", structuredPatch }))).toMatchObject([
      { toolUseId: "t", files: [{ path: "a.ts", change: "modified", patch: "@@ -9,2 +9,2 @@\n a\n-b\n+c", added: 1, removed: 1 }] },
    ]);
  });
  it("shows a new file, and nothing for a failure", () => {
    expect(diffs(edit({ type: "create", filePath: "/w/a.ts", content: "x\n", structuredPatch: [] }))).toMatchObject([{ files: [{ change: "added", patch: "@@ -0,0 +1,1 @@\n+x" }] }]);
    expect(diffs(edit({ filePath: "/w/a.ts", structuredPatch: [] }, true))).toEqual([]);
  });
});

describe("Codex file diffs", () => {
  const stdout = (id: string) => JSON.stringify({ type: "item.completed", item: { id, type: "file_change", status: "completed", changes: [{ path: "/w/a.ts", kind: "update" }] } });
  const rollout = (id: string, line: string) => ({ id, status: "completed", changes: { "/w/a.ts": { type: "update", unified_diff: `@@ -1 +1 @@\n-x\n+${line}\n` } } });

  it("pairs in either order, two edits of one file in turn", () => {
    const n = new CodexNormaliser(ctx);
    n.push(stdout("item_1"));
    n.push(stdout("item_2"));
    expect(diffs(n.observeFileChange(rollout("e1", "one")))).toMatchObject([{ toolUseId: "item_1", files: [{ path: "a.ts", patch: "@@ -1 +1 @@\n-x\n+one" }] }]);
    expect(diffs(n.observeFileChange(rollout("e2", "two")))).toMatchObject([{ toolUseId: "item_2" }]);
    expect(n.observeFileChange(rollout("e3", "three"))).toEqual([]);
    expect(diffs(n.push(stdout("item_3")))).toMatchObject([{ toolUseId: "item_3" }]);
    expect(n.settleFileChanges(true)).toEqual([]);
  });

  it("makes a call of a change stdout never told, once", () => {
    const n = new CodexNormaliser(ctx);
    n.observeFileChange(rollout("e1", "one"));
    expect(n.settleFileChanges(false)).toEqual([]);
    expect(n.settleFileChanges(true).map((e) => e.type)).toEqual(["agent.tool_use", "agent.tool_result", "agent.file_diff", "file.changed"]);
    expect(n.push(stdout("item_1"))).toEqual([]);
  });

  it("ignores the history of an earlier turn", () => {
    const n = new CodexNormaliser(ctx);
    const line = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", ...rollout("e1", "one") } } });
    n.subagents.replaying = true;
    n.subagents.parentRollout(line);
    expect(n.settleFileChanges(true)).toEqual([]);
  });

  it("stores its thoughts", () => {
    const n = new CodexNormaliser(ctx);
    expect(n.push(JSON.stringify({ type: "item.completed", item: { id: "r", type: "reasoning", text: "hm" } }))).toMatchObject([
      { type: "agent.thinking_delta", text: "hm" },
      { type: "agent.message", content: [{ type: "thinking", thinking: "hm" }] },
    ]);
  });
});
