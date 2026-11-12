import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { subagentConversation, subagentParentRequest } from "./subagent-chat";
import { toMessages } from "./chat-messages";
const ids = { threadId: "11111111-1111-4111-8111-111111111111", turnId: "22222222-2222-4222-8222-222222222222" };
const start: DomainEvent = { type: "agent.subagent_started", ...ids, subagentId: "alpha", parentToolUseId: "spawn", provider: "codex", agent: "alpha", model: null, description: null };
const rows = (...events: DomainEvent[]) => events.map(event => ({ event }));
describe("subagent conversation", () => {
  it("replays questions, answers and edits for the exact worker without parent/sibling output", () => {
    const events: DomainEvent[] = [start,
      { type: "agent.subagent_finished", ...ids, subagentId: "alpha", status: "completed", result: "Initial task done" },
      { type: "user.message", threadId: ids.threadId, subagentId: "alpha", text: "Change the current task" },
      { type: "turn.started", ...ids }, start,
      { type: "agent.subagent_output", ...ids, subagentId: "beta", kind: "text", text: "Sibling output" },
      { type: "agent.text_delta", ...ids, text: "Parent commentary" },
      { type: "agent.tool_use", ...ids, subagentId: "alpha", toolUseId: "edit", name: "apply_patch", input: { patch: "edit" } },
      { type: "agent.tool_result", ...ids, toolUseId: "edit", content: "Edited", isError: false, durationMs: 10 },
      { type: "agent.subagent_output", ...ids, subagentId: "alpha", kind: "text", text: "Updated the task" },
      { type: "agent.subagent_finished", ...ids, subagentId: "alpha", status: "completed", result: "Updated the task" },
    ];
    const messages = subagentConversation(rows(...events), "alpha");
    expect(messages.map(message => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages[1]!.text).toBe("Change the current task");
    expect(messages[2]!.parts).toMatchObject([{ kind: "tool", result: "Edited" }, { kind: "text", text: "Updated the task" }]);
    expect(JSON.stringify(messages)).not.toMatch(/Sibling output|Parent commentary/);
    expect(messages[2]!.streaming).toBe(false);
    expect(subagentConversation(rows(...events), "alpha")).toEqual(messages);
  });
  it("shows delivery failure rather than an invented answer", () => {
    const messages = subagentConversation(rows({ type: "user.message", threadId: ids.threadId, subagentId: "alpha", text: "Explain your task" }, { type: "turn.started", ...ids }, { type: "agent.turn_failed", ...ids, error: "Codex unavailable" }), "alpha");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", error: "Codex unavailable", streaming: false });
  });
  it("uses the actual parent request when the delegation is unavailable", () => {
    const messages = toMessages(rows({ type: "user.message", threadId: ids.threadId, text: "Inspect cache and tests" }, start)).messages;
    expect(subagentParentRequest(messages, "spawn")).toBe("Inspect cache and tests");
    expect(subagentParentRequest(messages, "missing")).toBeNull();
  });
});
