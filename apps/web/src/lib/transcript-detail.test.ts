import type { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import { toMessages, type MessagePart } from "./chat-messages";
import { classifyTool, fileViews, inputViews, parseShellResult } from "./tool-transcript";

const ids = { threadId: "t", turnId: "u" };
const fold = (events: unknown[]) => toMessages(events.map((event, i) => ({ seq: i + 1, event: event as DomainEvent })) as never).messages.at(-1)!;
const plain = (parts: MessagePart[]) =>
  parts.map((p) => (p.kind === "tool" ? `tool:${p.id}` : p.kind === "text" || p.kind === "thinking" ? `${p.kind}:${p.text}` : p.kind));

const durable = [
  { type: "turn.started", ...ids, provider: "claude" },
  { type: "agent.message", ...ids, content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "Doing it." }] },
  { type: "agent.tool_use", ...ids, toolUseId: "a", name: "Bash", input: { command: "ls" } },
  { type: "agent.tool_result", ...ids, toolUseId: "a", content: "x", isError: false, durationMs: 1 },
  { type: "agent.message", ...ids, content: [{ type: "thinking", thinking: "check" }] },
  { type: "agent.turn_completed", ...ids, stopReason: "end_turn", usage: {}, costUsd: 0 },
];

describe("thinking", () => {
  const want = ["thinking:plan", "text:Doing it.", "tool:a", "thinking:check"];
  it("is kept in order on a reload", () => {
    expect(plain(fold(durable).parts)).toEqual(want);
  });
  it("reads the same live as on a reload", () => {
    const live = [...durable];
    live.splice(4, 0, { type: "agent.thinking_delta", ...ids, text: "check" } as never);
    live.splice(1, 0, { type: "agent.thinking_delta", ...ids, text: "pl" } as never, { type: "agent.thinking_delta", ...ids, text: "an" } as never, { type: "agent.text_delta", ...ids, text: "Doing it." } as never);
    expect(plain(fold(live).parts)).toEqual(want);
  });
  it("keeps what streamed when the stored message withholds it", () => {
    const parts = fold([durable[0], { type: "agent.thinking_delta", ...ids, text: "hm" }, { type: "agent.message", ...ids, content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hi" }] }]).parts;
    expect(plain(parts)).toEqual(["thinking:hm", "text:Hi"]);
  });
  it("goes before prose already streaming when the page joined late", () => {
    const parts = fold([durable[0], { type: "agent.text_delta", ...ids, text: "Doing" }, durable[1]]).parts;
    expect(plain(parts)).toEqual(["thinking:plan", "text:Doing it."]);
  });
});

describe("file changes", () => {
  const file = { path: "a.ts", change: "modified", patch: "@@ -9,2 +9,2 @@\n x\n-a\n+b", added: 1, removed: 1, truncated: false } as const;
  it("hang from their call, and from the turn", () => {
    const message = fold([...durable, { type: "agent.file_diff", ...ids, toolUseId: "a", files: [file] }, { type: "agent.turn_diff", ...ids, files: [file], shared: true, omittedFiles: 0 }]);
    expect(message.parts.find((p) => p.kind === "tool")).toMatchObject({ diffs: [file] });
    expect(message.turnDiff).toMatchObject({ shared: true, files: [file] });
  });
  it("are drawn with the file's own line numbers", () => {
    expect(fileViews([file])[0]).toMatchObject({ numbered: true, hunks: [[{ kind: "context", oldNo: 9 }, { kind: "del", oldNo: 10 }, { kind: "add", newNo: 10 }]] });
  });
  it("read a patch envelope file by file", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n x\n-a\n+b\n*** Delete File: c.ts\n*** End Patch";
    const views = inputViews(classifyTool({ name: "apply_patch", input: { patch } }))!;
    expect(views.map((v) => [v.path, v.change, v.added, v.removed])).toEqual([["a.ts", "modified", 1, 1], ["c.ts", "deleted", 0, 0]]);
  });
  it("unwraps a shell in a string, and reads a plan", () => {
    expect(classifyTool({ name: "bash", input: { command: "/bin/bash -lc 'rg -n foo'" } })).toEqual({ kind: "shell", command: "rg -n foo" });
    const nested = `/usr/bin/bash -lc "sed -i 's/\"'^10$/ten/'\"' num.txt"`;
    expect(classifyTool({ name: "bash", input: { command: nested } })).toEqual({ kind: "shell", command: "sed -i 's/^10$/ten/' num.txt" });
    expect(classifyTool({ name: "bash", input: { command: "bash -c ls && rm x" } })).toEqual({ kind: "shell", command: "bash -c ls && rm x" });
    expect(parseShellResult("Exit code 2\nls: no")).toEqual({ output: "ls: no", exitCode: 2 });
    expect(classifyTool({ name: "plan_update", input: { items: [{ text: "x", completed: true }] } })).toEqual({ kind: "todo", items: [{ text: "x", status: "done" }] });
  });
});
