import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { INTERRUPTED, rebuild } from "./session-log.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";

const userMessage = (text: string): DomainEvent => ({ type: "user.message", threadId: THREAD, text });

const assistant = (content: unknown[]): DomainEvent => ({
  type: "agent.message",
  threadId: THREAD,
  turnId: TURN,
  content,
});

const toolUse = (id: string, name: string, args: string) => ({
  type: "tool_use",
  id,
  name,
  input: JSON.parse(args),
  arguments: args,
});

const toolResult = (toolUseId: string, content: string, isError = false): DomainEvent => ({
  type: "agent.tool_result",
  threadId: THREAD,
  turnId: TURN,
  toolUseId,
  content,
  isError,
  durationMs: 5,
});

describe("rebuild", () => {
  it("round-trips a turn with two parallel calls", () => {
    const messages = rebuild([
      userMessage("what is in src, and what time is it?"),
      assistant([
        { type: "text", text: "Let me look." },
        toolUse("call_0", "list_dir", '{"path":"src"}'),
        toolUse("call_1", "current_time", '{"timezone":null}'),
      ]),
      // Landed in the other order, because that is when they finished.
      toolResult("call_1", "Tuesday"),
      toolResult("call_0", "src\nindex.ts"),
      assistant([{ type: "text", text: "One file, and it is Tuesday." }]),
    ]);

    expect(messages).toEqual([
      { role: "user", content: "what is in src, and what time is it?" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          { id: "call_0", type: "function", function: { name: "list_dir", arguments: '{"path":"src"}' } },
          {
            id: "call_1",
            type: "function",
            function: { name: "current_time", arguments: '{"timezone":null}' },
          },
        ],
      },
      // In the assistant's order, not the log's: parallel tools finish
      // nondeterministically and the conversation must not inherit that.
      { role: "tool", tool_call_id: "call_0", content: "src\nindex.ts" },
      { role: "tool", tool_call_id: "call_1", content: "Tuesday" },
      { role: "assistant", content: "One file, and it is Tuesday." },
    ]);
  });

  it("replays the raw arguments string byte for byte", () => {
    // Deliberately not what JSON.stringify would produce: key order and
    // spacing both differ, and both would break the cached prefix.
    const raw = '{ "b": 2,  "a": 1 }';
    const messages = rebuild([
      assistant([{ type: "tool_use", id: "call_0", name: "grep", input: { a: 1, b: 2 }, arguments: raw }]),
      toolResult("call_0", "ok"),
    ]);

    expect(messages[0]).toMatchObject({
      tool_calls: [{ function: { arguments: raw } }],
    });
  });

  // A crash between dispatching a tool and recording its result: the API
  // rejects an assistant message whose tool_call has no reply, so without
  // the placeholder the thread would be unusable rather than interrupted.
  it("rebuilds a log truncated mid-turn into a valid message list", () => {
    const messages = rebuild([
      userMessage("read two files"),
      assistant([
        toolUse("call_0", "read_file", '{"path":"a.ts","offset":null,"limit":null}'),
        toolUse("call_1", "read_file", '{"path":"b.ts","offset":null,"limit":null}'),
      ]),
      toolResult("call_0", "1\tcontents of a"),
      // and then the process died.
    ]);

    expect(messages).toEqual([
      { role: "user", content: "read two files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts","offset":null,"limit":null}' },
          },
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"b.ts","offset":null,"limit":null}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_0", content: "1\tcontents of a" },
      { role: "tool", tool_call_id: "call_1", content: INTERRUPTED },
    ]);

    // Every call has exactly one reply, which is the property the API checks.
    const calls = messages.filter((m) => m.role === "assistant").flatMap((m) =>
      "tool_calls" in m ? (m.tool_calls ?? []) : [],
    );
    const replies = messages.filter((m) => m.role === "tool");
    expect(replies).toHaveLength(calls.length);
  });

  it("ignores deltas, injected context and everything else in the log", () => {
    const messages = rebuild([
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      {
        type: "context.injected",
        threadId: THREAD,
        source: "system_prompt",
        content: "rules",
      },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "par" },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "tial" },
      userMessage("hi"),
      assistant([{ type: "text", text: "partial" }]),
      {
        type: "agent.turn_completed",
        threadId: THREAD,
        turnId: TURN,
        stopReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0,
      },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial" },
    ]);
  });

  it("drops an assistant turn that said nothing and called nothing", () => {
    // `content: null` with no tool calls is rejected by some providers and
    // means nothing to any of them.
    expect(rebuild([userMessage("hi"), assistant([])])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("survives blocks written by an older version of the code", () => {
    const messages = rebuild([
      assistant([
        "not an object",
        { type: "unknown_block" },
        { type: "tool_use", id: "call_0", name: "glob" },
        // No `arguments`, so the parsed input is the only source left.
        { type: "tool_use", id: "call_1", name: "grep", input: { pattern: "x" } },
      ]),
      toolResult("call_0", "a"),
      toolResult("call_1", "b"),
    ]);

    expect(messages[0]).toMatchObject({
      tool_calls: [
        { id: "call_0", function: { name: "glob", arguments: "{}" } },
        { id: "call_1", function: { name: "grep", arguments: '{"pattern":"x"}' } },
      ],
    });
  });

  it("replaces an empty stored result, which no provider accepts", () => {
    const messages = rebuild([
      assistant([toolUse("call_0", "glob", '{"pattern":"*"}')]),
      toolResult("call_0", ""),
    ]);
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_0",
      content: INTERRUPTED,
    });
  });
});

describe("a compaction checkpoint", () => {
  const checkpoint = (content: string): DomainEvent => ({
    type: "context.injected",
    threadId: THREAD,
    source: "compaction",
    content,
  });

  const tree: DomainEvent = {
    type: "context.injected",
    threadId: THREAD,
    source: "file_tree",
    content: "Files in this project:\nindex.ts",
  };

  it("replaces everything logged before it, and replays what follows", () => {
    const messages = rebuild([
      userMessage("first"),
      assistant([{ type: "text", text: "done" }]),
      checkpoint("Read index.ts; the port is 3000."),
      userMessage("second"),
    ]);

    expect(messages).toHaveLength(2);
    expect(String(messages[0]!.content)).toContain("Read index.ts; the port is 3000.");
    expect(messages[1]).toEqual({ role: "user", content: "second" });
  });

  it("starts from the last checkpoint rather than stacking them", () => {
    const messages = rebuild([
      userMessage("first"),
      checkpoint("older"),
      userMessage("second"),
      checkpoint("newer"),
      userMessage("third"),
    ]);

    expect(messages).toHaveLength(2);
    expect(String(messages[0]!.content)).toContain("newer");
    expect(String(messages[0]!.content)).not.toContain("older");
    expect(messages[1]).toEqual({ role: "user", content: "third" });
  });

  it("is the only context.injected that means anything to a replay", () => {
    // The rest record what the prompt was, not what was said, and the prompt
    // is rebuilt from the workspace on every turn.
    expect(rebuild([tree, userMessage("hi")])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps a tool call and its result together after the fold", () => {
    const messages = rebuild([
      userMessage("first"),
      checkpoint("summary"),
      assistant([toolUse("call_a", "read_file", '{"path":"index.ts"}')]),
      toolResult("call_a", "1| hello"),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });
});
