import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import {
  describeSent,
  describeStop,
  describeTiming,
  estimateTokens,
  formatCookTime,
  formatDuration,
  splitThinking,
  summariseInput,
  toMessages,
} from "./chat-messages.js";
import { composeMessage, type Attachment } from "./attachments.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";

const log = (...events: DomainEvent[]) => toMessages(events.map((event) => ({ event })));

const message = (text: string, calls: { id: string; name: string }[] = []): DomainEvent => ({
  type: "agent.message",
  threadId: THREAD,
  turnId: TURN,
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: {} })),
  ],
});

/** The whole event sequence of a two-iteration tool turn, in order. */
const toolTurn: DomainEvent[] = [
  { type: "user.message", threadId: THREAD, text: "what files are here?" },
  { type: "turn.started", threadId: THREAD, turnId: TURN },
  message("Let me look.", [{ id: "call_0", name: "list_dir" }]),
  {
    type: "agent.tool_use",
    threadId: THREAD,
    turnId: TURN,
    toolUseId: "call_0",
    name: "list_dir",
    input: { path: "." },
  },
  {
    type: "agent.tool_result",
    threadId: THREAD,
    turnId: TURN,
    toolUseId: "call_0",
    content: "README.md\npackage.json",
    isError: false,
    durationMs: 12,
  },
  message("Two files."),
  {
    type: "agent.turn_completed",
    threadId: THREAD,
    turnId: TURN,
    stopReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    costUsd: 0,
  },
];

describe("toMessages", () => {
  it("puts the tool call inside the assistant bubble, between the two answers", () => {
    const { messages, running } = log(...toolTurn);

    expect(running).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", text: "what files are here?" });

    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    // Order is the whole point: the preamble, the call, then the answer.
    expect(assistant.parts).toEqual([
      { kind: "text", text: "Let me look.", streaming: false },
      {
        kind: "tool",
        id: "call_0",
        name: "list_dir",
        input: { path: "." },
        result: "README.md\npackage.json",
        isError: false,
        durationMs: 12,
      },
      { kind: "text", text: "Two files.", streaming: false },
    ]);
  });

  it("keeps the opening line a second iteration used to overwrite", () => {
    // The bug this fold replaces: one `text` field per turn meant the second
    // `agent.message` replaced the first, and the preamble vanished.
    const texts = log(...toolTurn)
      .messages[1]!.parts.filter((p) => p.kind === "text")
      .map((p) => p.text);
    expect(texts).toEqual(["Let me look.", "Two files."]);
  });

  it("does not draw the tool calls carried inside agent.message a second time", () => {
    const tools = log(...toolTurn).messages[1]!.parts.filter((p) => p.kind === "tool");
    expect(tools).toHaveLength(1);
  });

  it("streams deltas into the bubble and lets the stored message settle them", () => {
    const streaming = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "Hel" },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "lo" },
    );
    expect(streaming.running).toBe(true);
    expect(streaming.messages[0]!.parts).toEqual([{ kind: "text", text: "Hello", streaming: true }]);

    const settled = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "Hel" },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "lo" },
      message("Hello"),
    );
    expect(settled.messages[0]!.parts).toEqual([{ kind: "text", text: "Hello", streaming: false }]);
  });

  it("drops a streamed block a tool-only response never filled", () => {
    // Some providers open a text block and then emit only tool calls; an
    // empty bubble above the row is not worth drawing.
    const { messages } = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      message("", [{ id: "call_0", name: "glob" }]),
      {
        type: "agent.tool_use",
        threadId: THREAD,
        turnId: TURN,
        toolUseId: "call_0",
        name: "glob",
        input: {},
      },
    );
    expect(messages[0]!.parts.map((p) => p.kind)).toEqual(["tool"]);
  });

  it("shows a dispatched call with no result yet as still running", () => {
    const { messages, running } = log(...toolTurn.slice(0, 4));
    const tool = messages[1]!.parts.find((p) => p.kind === "tool")!;
    expect(tool.result).toBeNull();
    expect(running).toBe(true);
  });

  it("records parallel calls in call order and matches each result to its own", () => {
    const call = (id: string, name: string): DomainEvent => ({
      type: "agent.tool_use",
      threadId: THREAD,
      turnId: TURN,
      toolUseId: id,
      name,
      input: {},
    });
    const result = (id: string, content: string): DomainEvent => ({
      type: "agent.tool_result",
      threadId: THREAD,
      turnId: TURN,
      toolUseId: id,
      content,
      isError: false,
      durationMs: 1,
    });

    const { messages } = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      call("call_0", "read_file"),
      call("call_1", "grep"),
      // Results come back in whatever order they finish, which is not the
      // order they were dispatched in.
      result("call_1", "second"),
      result("call_0", "first"),
    );

    expect(messages[0]!.parts).toMatchObject([
      { name: "read_file", result: "first" },
      { name: "grep", result: "second" },
    ]);
  });

  it("keeps a result whose call fell off the front of the window", () => {
    const { messages } = log({
      type: "agent.tool_result",
      threadId: THREAD,
      turnId: TURN,
      toolUseId: "call_9",
      content: "orphan",
      isError: true,
      durationMs: 3,
    });
    expect(messages[0]!.parts).toMatchObject([{ kind: "tool", result: "orphan", isError: true }]);
  });

  it("marks an errored result without failing the turn", () => {
    const { messages } = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      {
        type: "agent.tool_use",
        threadId: THREAD,
        turnId: TURN,
        toolUseId: "call_0",
        name: "bash",
        input: { command: "false" },
      },
      {
        type: "agent.tool_result",
        threadId: THREAD,
        turnId: TURN,
        toolUseId: "call_0",
        content: "exit 1",
        isError: true,
        durationMs: 5,
      },
    );
    expect(messages[0]!.parts[0]).toMatchObject({ isError: true });
    expect(messages[0]!.error).toBeUndefined();
  });

  it("carries a cancellation as a stop reason, not as an error", () => {
    const { messages, running } = log(
      { type: "user.message", threadId: THREAD, text: "go" },
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "thread.cancel_requested", threadId: THREAD },
      {
        type: "agent.turn_completed",
        threadId: THREAD,
        turnId: TURN,
        stopReason: "cancelled",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0,
      },
    );

    expect(running).toBe(false);
    expect(messages[1]).toMatchObject({ stopReason: "cancelled", streaming: false });
    expect(messages[1]!.error).toBeUndefined();
  });

  it("closes a message that never became a turn, without an error", () => {
    const { messages, running } = log(
      { type: "user.message", threadId: THREAD, text: "go" },
      { type: "turn.dequeued", threadId: THREAD, reason: "restart" },
    );
    expect(running).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "dequeued", streaming: false, parts: [] });
    expect(messages[1]!.error).toBeUndefined();
    expect(messages[1]!.turnId).toBeUndefined();
    expect(describeStop(messages[1]!.stopReason)).toBe("Stopped before it started.");
  });

  it("reports a failed turn as an error", () => {
    const { messages, running } = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "no api key" },
    );
    expect(running).toBe(false);
    expect(messages[0]).toMatchObject({ error: "no api key", streaming: false });
  });

  it("stays running across a turn whose events are still arriving", () => {
    expect(log({ type: "turn.started", threadId: THREAD, turnId: TURN }).running).toBe(true);
  });

  it("closes the caret on every part when the turn completes", () => {
    const { messages } = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "partial" },
      {
        type: "agent.turn_completed",
        threadId: THREAD,
        turnId: TURN,
        stopReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0,
      },
    );
    expect(messages[0]!.parts).toEqual([{ kind: "text", text: "partial", streaming: false }]);
  });
});

describe("attachments on a user message", () => {
  const file = (over: Partial<Attachment> = {}): Attachment => ({
    id: "1",
    name: "cat.png",
    size: 2048,
    type: "image/png",
    text: null,
    uploadId: "up-1",
    status: "staged",
    ...over,
  });

  it("shows the sentence that was typed, not the block the model was sent", () => {
    const sent = composeMessage("add this to the directory", [file()]);
    const { messages } = log({ type: "user.message", threadId: THREAD, text: sent });

    expect(messages[0]!.text).toBe("add this to the directory");
    // None of the plumbing reaches the reader.
    expect(messages[0]!.text).not.toContain("attach_upload");
    expect(messages[0]!.text).not.toContain("up-1");
  });

  it("carries each file through as a tag", () => {
    const sent = composeMessage("these two", [
      file({ id: "1", name: "a.pdf", type: "application/pdf" }),
      file({ id: "2", name: "b.png" }),
    ]);
    const { messages } = log({ type: "user.message", threadId: THREAD, text: sent });

    expect(messages[0]!.attachments?.map((a) => a.name)).toEqual(["a.pdf", "b.png"]);
  });

  it("leaves an ordinary message without an attachments field at all", () => {
    const { messages } = log({ type: "user.message", threadId: THREAD, text: "just asking" });
    expect(messages[0]!.text).toBe("just asking");
    expect(messages[0]!.attachments).toBeUndefined();
  });
});

describe("the mode of a user message", () => {
  it("carries research through, and leaves an ordinary message unmarked", () => {
    const { messages } = log(
      { type: "user.message", threadId: THREAD, text: "what is new in next 15?", mode: "research" },
      { type: "user.message", threadId: THREAD, text: "now add it" },
    );
    expect(messages[0]!.mode).toBe("research");
    expect(messages[1]).not.toHaveProperty("mode");
  });

  it("carries documentation through", () => {
    const { messages } = log({
      type: "user.message",
      threadId: THREAD,
      text: "turn the failover notes into a runbook PDF",
      mode: "documentation",
    });
    expect(messages[0]!.mode).toBe("documentation");
  });
});

describe("the running turn", () => {
  const at = (event: DomainEvent, receivedAt: number) => ({ event, receivedAt });

  it("reports nothing while the thread is idle", () => {
    expect(log({ type: "user.message", threadId: THREAD, text: "hi" }).active).toBeNull();
  });

  it("reports when the turn started and how much has streamed back", () => {
    const state = toMessages([
      at({ type: "turn.started", threadId: THREAD, turnId: TURN }, 1_000),
      at({ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "12345678" }, 1_500),
      at({ type: "agent.thinking_delta", threadId: THREAD, turnId: TURN, text: "1234" }, 1_600),
    ]);

    expect(state.active).toMatchObject({ turnId: TURN, startedAt: 1_000, chars: 12 });
  });

  it("counts the arguments the model writes, so a long tool call is not silence", () => {
    const state = toMessages([
      at({ type: "turn.started", threadId: THREAD, turnId: TURN }, 0),
      at(
        {
          type: "agent.tool_use",
          threadId: THREAD,
          turnId: TURN,
          toolUseId: "call_0",
          name: "write_file",
          input: { path: "a.txt", content: "hello" },
        },
        1,
      ),
    ]);

    expect(state.active!.chars).toBeGreaterThan(20);
  });

  it("stops reporting once the turn ends", () => {
    const finished = log(
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "done" },
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
    );

    expect(finished.running).toBe(false);
    expect(finished.active).toBeNull();
  });

  it("has no start to show when the turn was already running on load", () => {
    // The push frame carries no timestamp, so a replayed `turn.started` has
    // none either: better no clock than one that says four seconds after
    // four minutes of work.
    const state = log({ type: "turn.started", threadId: THREAD, turnId: TURN });
    expect(state.active).toMatchObject({ turnId: TURN, startedAt: null });
  });
});

describe("the context window", () => {
  const completed = (input: number, output: number, turnId = TURN): DomainEvent => ({
    type: "agent.turn_completed",
    threadId: THREAD,
    turnId,
    stopReason: "stop",
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    costUsd: 0,
  });

  it("knows nothing until a turn has finished", () => {
    expect(log({ type: "user.message", threadId: THREAD, text: "hi" }).contextTokens).toBeNull();
    expect(
      log(
        { type: "turn.started", threadId: THREAD, turnId: TURN },
        { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "working" },
      ).contextTokens,
    ).toBeNull();
  });

  it("is the last turn's prompt plus what the model wrote back", () => {
    expect(log(completed(12_000, 400)).contextTokens).toBe(12_400);
  });

  it("does not add the cache figures to the prompt they are part of", () => {
    // `inputTokens` is `prompt_tokens`, which already includes the cached
    // prefix -- adding the cache numbers would count most of the
    // conversation twice and show a window that fills at double speed.
    const cached = log({
      type: "agent.turn_completed",
      threadId: THREAD,
      turnId: TURN,
      stopReason: "stop",
      usage: {
        inputTokens: 12_000,
        outputTokens: 400,
        cacheReadInputTokens: 11_000,
        cacheCreationInputTokens: 500,
      },
      costUsd: 0,
    });

    expect(cached.contextTokens).toBe(12_400);
  });

  it("follows the newest turn, because the conversation only grows", () => {
    const state = log(
      completed(4_000, 200, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      completed(9_000, 300, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    );
    expect(state.contextTokens).toBe(9_300);
  });
});

describe("estimateTokens", () => {
  it("counts four characters to the token", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(67_600)).toBe(16_900);
  });
});

describe("describeStop", () => {
  it("explains the two stops that are not failures", () => {
    expect(describeStop("cancelled")).toMatch(/your request/);
    expect(describeStop("max_iterations")).toMatch(/maximum number of steps/);
  });

  it("says nothing about an ordinary end of turn", () => {
    expect(describeStop("stop")).toBeNull();
    expect(describeStop(null)).toBeNull();
    expect(describeStop(undefined)).toBeNull();
  });
});

describe("summariseInput", () => {
  it("prefers the argument a reader looks for first", () => {
    expect(summariseInput({ offset: 1, path: "src/index.ts" })).toBe("src/index.ts");
    expect(summariseInput({ command: "ls -la" })).toBe("ls -la");
  });

  it("falls back to the first string, and flattens it to one line", () => {
    expect(summariseInput({ note: "two\nlines" })).toBe("two lines");
  });

  it("has nothing to say about an argumentless call", () => {
    expect(summariseInput({})).toBe("");
    expect(summariseInput(null)).toBe("");
    expect(summariseInput(42)).toBe("");
  });

  it("truncates rather than letting one row take the width of the pane", () => {
    expect(summariseInput({ command: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("formatDuration", () => {
  it("reads in milliseconds below a second and in seconds above one", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(null)).toBeNull();
  });
});

describe("turn timing", () => {
  const at = (event: DomainEvent, receivedAt: number) => ({ event, receivedAt });
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  it("dates a turn from its start to its completion", () => {
    const { messages } = toMessages([
      at({ type: "turn.started", threadId: THREAD, turnId: TURN }, 1_000),
      at({ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "hi" }, 1_500),
      at(
        { type: "agent.turn_completed", threadId: THREAD, turnId: TURN, stopReason: "end_turn", usage, costUsd: 0 },
        530_000,
      ),
    ]);
    expect(messages[0]).toMatchObject({ startedAt: 1_000, completedAt: 530_000 });
  });

  it("dates a failed turn too, and leaves a start it never saw null", () => {
    const { messages } = toMessages([
      at({ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "hi" }, 1_500),
      at({ type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "boom" }, 2_000),
    ]);
    expect(messages[0]).toMatchObject({ startedAt: null, completedAt: 2_000 });
  });

  it("formats the line, dropping whichever half it cannot know", () => {
    const done = new Date(2026, 0, 1, 18, 42).getTime();
    expect(describeTiming({ startedAt: done - 529_000, completedAt: done }, "en-US")).toBe(
      "Cooked for 8m 49s · done 6:42 PM",
    );
    expect(describeTiming({ startedAt: null, completedAt: done }, "en-US")).toBe("done 6:42 PM");
    expect(describeTiming({ startedAt: 1, completedAt: null })).toBeNull();
    expect(describeTiming({ startedAt: null, completedAt: null })).toBeNull();
  });

  it("formats cook times in the largest two whole units", () => {
    expect(formatCookTime(0)).toBe("0s");
    expect(formatCookTime(49_400)).toBe("49s");
    expect(formatCookTime(529_000)).toBe("8m 49s");
    expect(formatCookTime(3_720_000)).toBe("1h 2m");
  });
});

describe("splitThinking", () => {
  it("leaves prose without tags alone", () => {
    expect(splitThinking("Just an answer.")).toEqual([{ kind: "answer", text: "Just an answer." }]);
  });

  it("separates a closed think block from the answer around it", () => {
    expect(splitThinking("<think>hmm</think>Yes.")).toEqual([
      { kind: "think", text: "hmm" },
      { kind: "answer", text: "Yes." },
    ]);
  });

  it("runs an unclosed think block to the end of the part when nothing marks the seam", () => {
    expect(splitThinking("<think> I have a clearer picture now.\n\nLet me check.")).toEqual([
      { kind: "think", text: " I have a clearer picture now.\n\nLet me check." },
    ]);
  });

  it("splits an unclosed block where a stripped closing tag glued the answer on", () => {
    // Verbatim from a stored turn: the provider removed `</think>` and the
    // newline after it, leaving "answer.This".
    const text =
      "<think>\nNow I have a clear picture. It uses `.env.example` and Inertia.js. Let me give a concise but thoroughanswer.This is **BrainPanel** — a self-hosted app.\n\n**Core**\n- Projects";
    expect(splitThinking(text)).toEqual([
      {
        kind: "think",
        text: "\nNow I have a clear picture. It uses `.env.example` and Inertia.js. Let me give a concise but thoroughanswer.",
      },
      { kind: "answer", text: "This is **BrainPanel** — a self-hosted app.\n\n**Core**\n- Projects" },
    ]);
    expect(splitThinking("<think>Done thinking.**Answer** here")).toEqual([
      { kind: "think", text: "Done thinking." },
      { kind: "answer", text: "**Answer** here" },
    ]);
  });

  it("handles several blocks, odd spacing and case", () => {
    expect(splitThinking("< THINK >a</think>\n\n<think>b</ think>The answer")).toEqual([
      { kind: "think", text: "a" },
      { kind: "think", text: "b" },
      { kind: "answer", text: "The answer" },
    ]);
  });

  it("drops an empty thought and keeps an answer that is only whitespace out of the way", () => {
    expect(splitThinking("<think></think>ok")).toEqual([{ kind: "answer", text: "ok" }]);
    expect(splitThinking("<think>x</think>  ")).toEqual([{ kind: "think", text: "x" }]);
  });
});

describe("which provider answered", () => {
  it("is carried from turn.started onto the assistant message", () => {
    const state = log(
      { type: "user.message", threadId: THREAD, text: "hi" },
      { type: "turn.started", threadId: THREAD, turnId: TURN, provider: "claude" },
      message("hello"),
      {
        type: "agent.turn_completed",
        threadId: THREAD,
        turnId: TURN,
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        costUsd: 0,
      },
    );
    expect(state.messages[1]?.provider).toBe("claude");
  });

  it("is absent on turns written before the field existed", () => {
    const state = log(
      { type: "user.message", threadId: THREAD, text: "hi" },
      { type: "turn.started", threadId: THREAD, turnId: TURN },
    );
    expect(state.messages[1]?.provider).toBeUndefined();
  });
});

describe("a retry in progress", () => {
  it("shows on the active turn until output resumes", () => {
    const waiting = log(
      { type: "user.message", threadId: THREAD, text: "hi" },
      { type: "turn.started", threadId: THREAD, turnId: TURN, provider: "claude" },
      { type: "agent.retry", threadId: THREAD, turnId: TURN, attempt: 2, maxRetries: 10, delayMs: 500, category: "overloaded" },
    );
    expect(waiting.active?.retry).toEqual({ attempt: 2, maxRetries: 10 });

    const resumed = log(
      { type: "user.message", threadId: THREAD, text: "hi" },
      { type: "turn.started", threadId: THREAD, turnId: TURN, provider: "claude" },
      { type: "agent.retry", threadId: THREAD, turnId: TURN, attempt: 2, maxRetries: 10, delayMs: 500, category: "overloaded" },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "ok" },
    );
    expect(resumed.active?.retry).toBeUndefined();
  });
});

describe("describeSent", () => {
  const now = new Date(2026, 8, 13, 18, 0);

  it("is the time alone on the same day", () => {
    expect(describeSent(new Date(2026, 8, 13, 6, 42).getTime(), "en-US", now)).toBe("6:42 AM");
  });

  it("adds the date on another day, and the year in another year", () => {
    expect(describeSent(new Date(2026, 8, 6, 6, 42).getTime(), "en-US", now)).toBe("Sep 6, 6:42 AM");
    expect(describeSent(new Date(2025, 11, 31, 23, 5).getTime(), "en-US", now)).toBe(
      "Dec 31, 2025, 11:05 PM",
    );
  });

  it("is nothing when the message carried no time", () => {
    expect(describeSent(null)).toBeNull();
  });
});
