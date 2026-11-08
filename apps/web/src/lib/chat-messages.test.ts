import { describe, expect, it } from "vitest";
import { isTransient, type DomainEvent } from "@ucch/protocol";
import {
  describeCompaction,
  describeSent,
  describeStop,
  describeTiming,
  estimateTokens,
  formatCookTime,
  formatDuration,
  isSubagentCall,
  overlayLive,
  promptOf,
  splitBrief,
  splitSubagentTask,
  splitThinking,
  summariseInput,
  toMessages as foldAll,
} from "./chat-messages.js";
import { composeMessage, type Attachment } from "./attachments.js";
import type { ClientEvent } from "./client.js";
import { ThreadStore } from "./thread-store.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";

/**
 * `toMessages`, and on every fixture in this file, a check that the chat's
 * own path draws the same: the events through a thread store, the settled
 * part folded once, and the turns still streaming laid over it.
 */
function toMessages(rows: readonly { event: DomainEvent; receivedAt?: number }[]) {
  const direct = foldAll(rows);
  const store = new ThreadStore(THREAD);
  rows.forEach((row, i) =>
    store.push({ seq: isTransient(row.event.type) ? null : i, event: row.event, receivedAt: row.receivedAt } as ClientEvent),
  );
  expect(overlayLive(foldAll(store.durable), store.live)).toEqual(direct);
  store.dispose();
  return direct;
}

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

  it("knows nothing again once the context is cleared", () => {
    const state = log(completed(12_000, 400), { type: "thread.context_cleared", threadId: THREAD });
    expect(state.contextTokens).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", cleared: true, streaming: false });
    // The turn before the clear is still on screen.
    expect(state.messages.some((m) => m.turnId === TURN)).toBe(true);
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

describe("a compaction", () => {
  const compacted = (extra: object = {}): DomainEvent => ({
    type: "context.injected",
    threadId: THREAD,
    turnId: TURN,
    source: "compaction",
    content: "Summary so far.",
    compaction: { method: "handoff", tokensBefore: 142_000, tokensAfter: 31_000 },
    ...extra,
  });

  it("is a divider in its turn's answer, between the prose before and after it", () => {
    const { messages } = log(
      { type: "user.message", threadId: THREAD, text: "go" },
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "Before." },
      compacted(),
      { type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "After." },
    );
    expect(messages[1]!.parts).toEqual([
      { kind: "text", text: "Before.", streaming: false },
      { kind: "compaction", summary: "Summary so far.", method: "handoff", tokensBefore: 142_000, tokensAfter: 31_000 },
      { kind: "text", text: "After.", streaming: true },
    ]);
  });

  it("with no turn, goes under the answer before it; and nothing else injected is drawn", () => {
    const { messages } = log(
      ...toolTurn,
      { type: "context.injected", threadId: THREAD, source: "system_prompt", content: "rules" },
      compacted({ turnId: undefined, compaction: undefined }),
    );
    const parts = messages.at(-1)!.parts;
    expect(parts.filter((p) => p.kind === "compaction")).toEqual([
      { kind: "compaction", summary: "Summary so far.", method: null, tokensBefore: null, tokensAfter: null },
    ]);
    expect(parts.at(-1)!.kind).toBe("compaction");
  });

  it("between turns, keeps the thread busy until it finishes, and says why one did not happen", () => {
    const requested: DomainEvent = { type: "thread.compaction_requested", threadId: THREAD, method: "handoff" };
    const ended: DomainEvent = {
      type: "agent.turn_completed",
      threadId: THREAD,
      turnId: TURN,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0,
    };
    // The turn before it is over: its progress line must not come back.
    const busy = log(...toolTurn, ended, requested);
    expect(busy).toMatchObject({ running: true, compacting: "handoff", compactionError: null, active: null });
    const done = log(...toolTurn, requested, { type: "thread.compaction_finished", threadId: THREAD, method: "handoff" });
    expect(done).toMatchObject({ running: false, compacting: null, compactionError: null });
    const failed = log(...toolTurn, requested, {
      type: "thread.compaction_finished",
      threadId: THREAD,
      method: "compact",
      error: "Already compacted",
    });
    expect(failed).toMatchObject({ running: false, compactionError: "Compacting did not happen: Already compacted" });
    // The next turn clears it.
    const next = log(...toolTurn, requested, { type: "thread.compaction_finished", threadId: THREAD, method: "compact", error: "x" }, {
      type: "turn.started",
      threadId: THREAD,
      turnId: "99999999-9999-4999-8999-999999999999",
    });
    expect(next.compactionError).toBeNull();
  });

  it("between turns, a handoff keeps the thread busy, then says where the work went", () => {
    const requested: DomainEvent = { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "codex" };
    expect(log(...toolTurn, requested)).toMatchObject({ running: true, handingOff: "codex", active: null, continuedIn: null });
    const handed: DomainEvent = {
      type: "thread.handed_off",
      threadId: THREAD,
      fromThreadId: THREAD,
      fromHash: "s0urce0hash0",
      toThreadId: TURN,
      toHash: "n3wsess10n00",
      targetProvider: "codex",
      brief: "## Goal",
    };
    expect(log(...toolTurn, requested, handed)).toMatchObject({
      running: false,
      handingOff: null,
      continuedIn: { threadId: TURN, hash: "n3wsess10n00", provider: "codex" },
      continuedFrom: null,
    });
    expect(log(...toolTurn, requested, { ...handed, reason: "limit" }).continuedIn).toEqual({
      threadId: TURN,
      hash: "n3wsess10n00",
      provider: "codex",
      limit: true,
    });
    expect(log(...toolTurn, requested, { type: "thread.handoff_failed", threadId: THREAD, error: "no key" })).toMatchObject({
      running: false,
      handingOff: null,
      compactionError: "The handoff did not happen: no key",
    });
  });

  it("opens a thread a handoff started with where it came from, and its brief folded apart", () => {
    const SOURCE = "77777777-7777-4777-8777-777777777777";
    const state = log(
      {
        type: "thread.handed_off",
        threadId: THREAD,
        fromThreadId: SOURCE,
        fromHash: "s0urce0hash0",
        toThreadId: THREAD,
        toHash: "n3wsess10n00",
        targetProvider: "claude",
        brief: "## Goal\nShip it.",
      },
      { type: "user.message", threadId: THREAD, text: "<handoff-brief>\n## Goal\nShip it.\n</handoff-brief>\n\nContinue from here." },
    );
    expect(state.continuedFrom).toEqual({ threadId: SOURCE, hash: "s0urce0hash0" });
    expect(state.continuedIn).toBeNull();
    expect(state.messages).toEqual([expect.objectContaining({ role: "user", brief: "## Goal\nShip it.", text: "Continue from here." })]);
  });

  it("splits only a message that is a handoff's", () => {
    expect(splitBrief("<handoff-brief>\nA\nB\n</handoff-brief>")).toEqual({ brief: "A\nB", text: "" });
    expect(splitBrief("see <handoff-brief>\nx\n</handoff-brief>")).toBeNull();
    expect(splitBrief("plain")).toBeNull();
  });

  it("says what happened, leaving out what the provider did not say", () => {
    expect(describeCompaction({ method: "handoff", tokensBefore: 142_000, tokensAfter: 31_000 })).toBe(
      "Context compacted (handoff) · 142k → 31k tokens",
    );
    expect(describeCompaction({ method: null, tokensBefore: 7832, tokensAfter: null })).toBe("Context compacted · from 8k tokens");
    expect(describeCompaction({ method: null, tokensBefore: null, tokensAfter: null })).toBe("Context compacted");
  });
});

describe("overlayLive", () => {
  it("replaces only the streaming turn's message, keeping every other one as it was", () => {
    const store = new ThreadStore(THREAD);
    const rows: DomainEvent[] = [
      ...toolTurn,
      { type: "user.message", threadId: THREAD, text: "and now?" },
      { type: "turn.started", threadId: THREAD, turnId: "66666666-6666-6666-6666-666666666666" },
    ];
    rows.forEach((event, i) => store.push({ seq: i, event, receivedAt: i }));
    const base = foldAll(store.durable);
    store.push({
      seq: null,
      event: { type: "agent.text_delta", threadId: THREAD, turnId: "66666666-6666-6666-6666-666666666666", text: "Still" },
      receivedAt: 99,
    });
    const shown = overlayLive(base, store.live);
    expect(shown.messages.slice(0, -1)).toEqual(base.messages.slice(0, -1));
    shown.messages.slice(0, -1).forEach((message, i) => expect(message).toBe(base.messages[i]));
    expect(shown.messages.at(-1)!.parts).toEqual([{ kind: "text", text: "Still", streaming: true }]);
    expect(shown.active).toMatchObject({ chars: 5 });
    expect(overlayLive(base, [])).toBe(base);
    store.dispose();
  });
});

describe("subagents (OM5.3)", () => {
  const ids = { threadId: THREAD, turnId: TURN };
  const call = (name: string, id = "call_1"): DomainEvent => ({
    type: "agent.tool_use",
    ...ids,
    toolUseId: id,
    name,
    input: { agent: "scout", tasks: [{ task: "Look at a" }, { task: "Look at b" }] },
  });
  const started = (id: string, parent: string | null = "call_1"): DomainEvent => ({
    type: "agent.subagent_started",
    ...ids,
    subagentId: id,
    parentToolUseId: parent,
    agent: "scout",
    description: `Look at ${id}`,
    model: null,
  });
  const progress = (id: string, summary: string): DomainEvent => ({
    type: "agent.subagent_progress",
    ...ids,
    subagentId: id,
    summary,
    toolCalls: 2,
    model: "m/cheap",
    durationMs: 900,
  });
  const finished = (id: string, status: "completed" | "failed" | "aborted" = "completed"): DomainEvent => ({
    type: "agent.subagent_finished",
    ...ids,
    subagentId: id,
    status,
    result: `${id} is fine.`,
    toolCalls: 3,
    durationMs: 1200,
    costUsd: 0.002,
  });

  it("names the calls that spawn subagents", () => {
    for (const name of ["task", "Task", "Agent", "mcp__omp__omp_task"]) expect(isSubagentCall(name)).toBe(true);
    expect(isSubagentCall("read")).toBe(false);
  });

  it("hangs each subagent on its call, with its live line while it runs", () => {
    const state = log({ type: "turn.started", ...ids }, call("task"), started("a"), started("b"), progress("a", "Reading a.ts"));
    const part = state.messages[0]!.parts[0]!;
    expect(part.kind === "tool" && part.subagents).toEqual([
      { id: "a", agent: "scout", description: "Look at a", model: "m/cheap", status: "running", summary: "Reading a.ts", toolCalls: 2, durationMs: 900, costUsd: null, result: null, steps: [] },
      { id: "b", agent: "scout", description: "Look at b", model: null, status: "running", summary: null, toolCalls: null, durationMs: null, costUsd: null, result: null, steps: [] },
    ]);
  });

  it("keeps the latest progress only, and the result once it is done", () => {
    const state = log(
      { type: "turn.started", ...ids },
      call("Agent"),
      started("a"),
      progress("a", "one"),
      progress("a", "two"),
      finished("a"),
      { type: "agent.tool_result", ...ids, toolUseId: "call_1", content: "Async agent launched", isError: false, durationMs: 5 },
    );
    const part = state.messages[0]!.parts[0]!;
    expect(part.kind === "tool" && part.subagents?.[0]).toMatchObject({
      status: "completed",
      summary: "two",
      result: "a is fine.",
      toolCalls: 3,
      durationMs: 1200,
      costUsd: 0.002,
    });
  });

  it("gives a subagent whose call was never seen a card of its own", () => {
    const state = log({ type: "turn.started", ...ids }, started("x", null), finished("x", "failed"));
    const part = state.messages[0]!.parts[0]!;
    expect(part).toMatchObject({ kind: "tool", name: "task", orphan: true, result: "", isError: true });
    expect(part.kind === "tool" && part.subagents?.[0]?.status).toBe("failed");
  });

  it("stops what is still running when the turn ends", () => {
    const state = log(
      { type: "turn.started", ...ids },
      call("task"),
      started("a"),
      { type: "agent.turn_completed", ...ids, stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 },
    );
    const part = state.messages[0]!.parts[0]!;
    expect(part.kind === "tool" && part.subagents?.[0]?.status).toBe("aborted");
  });

  it("puts a subagent resumed in a later turn back on its first card, not a second one", () => {
    const later = { threadId: THREAD, turnId: "turn_2" };
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const state = log(
      { type: "turn.started", ...ids },
      call("Agent", "call_1"),
      started("call_1"),
      finished("call_1", "aborted"),
      { type: "agent.turn_completed", ...ids, stopReason: "end_turn", usage, costUsd: 0 },
      { type: "turn.started", ...later },
      { ...started("call_1"), ...later },
      { ...finished("call_1"), ...later },
      { type: "agent.turn_completed", ...later, stopReason: "end_turn", usage, costUsd: 0 },
    );
    const cards = state.messages.flatMap((m) => m.parts).filter((p) => p.kind === "tool" && p.id === "call_1");
    expect(cards).toHaveLength(1);
    const part = cards[0]!;
    expect(part.kind === "tool" && part.subagents).toEqual([expect.objectContaining({ id: "call_1", status: "completed", result: "call_1 is fine." })]);
  });

  it("ignores a repeated start", () => {
    const state = log({ type: "turn.started", ...ids }, call("task"), started("a"), started("a"));
    const part = state.messages[0]!.parts[0]!;
    expect(part.kind === "tool" && part.subagents).toHaveLength(1);
  });
});

describe("switching harness in the same session", () => {
  const ev = (event: DomainEvent) => ({ event });

  it("is busy while the brief is written, then draws a row where the switch happened", () => {
    const requested = toMessages([
      ev({ type: "user.message", threadId: THREAD, text: "hi" }),
      ev({ type: "thread.harness_switch_requested", threadId: THREAD, fromProvider: "claude", targetProvider: "codex" }),
    ]);
    expect(requested).toMatchObject({ running: true, switching: "codex" });

    const switched = toMessages([
      ev({ type: "user.message", threadId: THREAD, text: "hi" }),
      ev({ type: "thread.harness_switch_requested", threadId: THREAD, fromProvider: "claude", targetProvider: "codex" }),
      ev({
        type: "thread.harness_switched",
        threadId: THREAD,
        fromProvider: "claude",
        toProvider: "codex",
        model: "gpt-6-sol",
        brief: "Did A; next B.",
        reason: "limit",
      }),
    ]);
    expect(switched.running).toBe(false);
    expect(switched.switching).toBeNull();
    expect(switched.messages.at(-1)?.switched).toEqual({
      from: "claude",
      to: "codex",
      model: "gpt-6-sol",
      brief: "Did A; next B.",
      limit: true,
    });
  });

  it("says why when the switch did not happen", () => {
    const failed = toMessages([
      ev({ type: "thread.harness_switch_requested", threadId: THREAD, fromProvider: "claude", targetProvider: "codex" }),
      ev({ type: "thread.harness_switch_failed", threadId: THREAD, error: "add an OpenRouter key" }),
    ]);
    expect(failed).toMatchObject({ running: false, switching: null, compactionError: "The switch did not happen: add an OpenRouter key" });
  });
});

describe("choice cards", () => {
  const ev = (event: DomainEvent) => ({ event });
  const card: DomainEvent = {
    type: "agent.choice_requested",
    threadId: THREAD,
    requestId: "r1",
    kind: "harness_limit",
    title: "Claude Code hit its usage limit",
    options: [{ id: "codex", label: "Continue on Codex", provider: "codex" }],
    provider: "claude",
    message: "Add the test",
  };

  it("stays open until it is answered", () => {
    expect(toMessages([ev(card)]).choices).toMatchObject([{ requestId: "r1", kind: "harness_limit" }]);
    expect(toMessages([ev(card), ev({ type: "agent.choice_resolved", threadId: THREAD, requestId: "r1", optionId: "codex" })]).choices).toEqual([]);
  });

  it("closes the thread's own card when a new turn overtakes it, but not a subagent's", () => {
    const subagent: DomainEvent = { ...card, requestId: "r2", kind: "subagent_limit", childThreadId: "66666666-6666-4666-8666-666666666666" } as DomainEvent;
    const state = toMessages([ev(card), ev(subagent), ev({ type: "turn.started", threadId: THREAD, turnId: TURN })]);
    expect(state.choices.map((choice) => choice.requestId)).toEqual(["r2"]);
  });
});

describe("a subagent on another harness", () => {
  it("is a subagent call, and its run carries its harness and session", () => {
    expect(isSubagentCall("mcp__omp__ucch_agent")).toBe(true);
    expect(isSubagentCall("ucch_agent")).toBe(true);
    const state = toMessages([
      { event: { type: "turn.started", threadId: THREAD, turnId: TURN } },
      {
        event: {
          type: "agent.tool_use",
          threadId: THREAD,
          turnId: TURN,
          toolUseId: "toolu_1",
          name: "mcp__omp__ucch_agent",
          input: { description: "Research", task: "Look", model: "gpt6 sol" },
        },
      },
      {
        event: {
          type: "agent.subagent_started",
          threadId: THREAD,
          turnId: TURN,
          subagentId: "s1",
          parentToolUseId: "toolu_1",
          agent: "Codex",
          description: "Research",
          model: "gpt-6-sol",
          provider: "codex",
          childThreadId: "66666666-6666-4666-8666-666666666666",
          childHash: "child1234567",
          routing: "gpt-6-sol on Codex",
        },
      },
    ]);
    const call = state.messages.at(-1)?.parts.find((part) => part.kind === "tool");
    expect(call && call.kind === "tool" ? call.subagents?.[0] : null).toMatchObject({
      provider: "codex",
      childHash: "child1234567",
      routing: "gpt-6-sol on Codex",
      model: "gpt-6-sol",
    });
  });
});

describe("a subagent's own session", () => {
  const PREAMBLE =
    "You are a subagent. Another agent started you for one task, and your final reply is all it receives. You cannot see its conversation; everything you need is below. Work in this folder, and finish with a concise report of what you did and found.";
  const opening = `${PREAMBLE}\n\n<task>\nFind where the cache is cleared.\n\nReport file and line.\n</task>`;

  it("splits the server's preamble off its task", () => {
    expect(splitSubagentTask(opening)).toEqual({ task: "Find where the cache is cleared.\n\nReport file and line." });
    expect(splitSubagentTask("Find where the cache is cleared.")).toBeNull();
    expect(splitSubagentTask("<task>\nNot from the server\n</task>")).toBeNull();
  });

  it("shows the task, and keeps the message as sent for a rerun", () => {
    const state = toMessages([{ event: { type: "user.message", threadId: THREAD, text: opening } }]);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      text: "Find where the cache is cleared.\n\nReport file and line.",
      subagentTask: true,
      raw: opening,
    });
  });

  it("leaves an ordinary message alone", () => {
    const state = toMessages([{ event: { type: "user.message", threadId: THREAD, text: "hello" } }]);
    expect(state.messages[0]?.subagentTask).toBeUndefined();
    expect(state.messages[0]?.raw).toBeUndefined();
  });
});

describe("promptOf", () => {
  it("prefers the full prompt to the one-line description", () => {
    expect(promptOf({ description: "Find it", prompt: "Find the cache, in detail" })).toBe("Find the cache, in detail");
    expect(promptOf({ description: "Research", task: "Look" })).toBe("Look");
    expect(promptOf({ description: "Only this" })).toBe("Only this");
    expect(promptOf("a bare string")).toBe("a bare string");
    expect(promptOf(null)).toBeNull();
  });

  it("picks the matching task of several, with the shared context", () => {
    const input = {
      context: "The repo is a monorepo.",
      tasks: [
        { id: "a", description: "Look at a", assignment: "Read a.ts" },
        { id: "b", description: "Look at b", assignment: "Read b.ts" },
      ],
    };
    expect(promptOf(input, { id: "b" })).toBe("The repo is a monorepo.\n\nRead b.ts");
    expect(promptOf(input, { description: "Look at a" })).toBe("The repo is a monorepo.\n\nRead a.ts");
    expect(promptOf(input, { id: "zzz" })).toBe("The repo is a monorepo.");
  });
});

describe("a built-in subagent's steps", () => {
  const ids = { threadId: THREAD, turnId: TURN };
  const steps = (...events: DomainEvent[]) => {
    const { messages } = toMessages(
      [
        { type: "turn.started", ...ids } as DomainEvent,
        { type: "agent.tool_use", ...ids, toolUseId: "toolu_task", name: "Task", input: { description: "Look" } } as DomainEvent,
        {
          type: "agent.subagent_started",
          ...ids,
          subagentId: "toolu_task",
          parentToolUseId: "toolu_task",
          agent: "Explore",
          description: "Look",
          model: null,
        } as DomainEvent,
        ...events,
      ].map((event) => ({ event })),
    );
    const turn = messages.at(-1)!;
    const card = turn.parts.find((part) => part.kind === "tool" && part.id === "toolu_task");
    return { turn, run: card?.kind === "tool" ? card.subagents?.[0] : undefined };
  };

  it("files its thinking, prose and calls under the run, in order, and not under the turn", () => {
    const { turn, run } = steps(
      { type: "agent.subagent_output", ...ids, subagentId: "toolu_task", kind: "thinking", text: "Where?" },
      { type: "agent.tool_use", ...ids, toolUseId: "toolu_read", name: "Read", input: { file_path: "a.ts" }, subagentId: "toolu_task" },
      { type: "agent.tool_result", ...ids, toolUseId: "toolu_read", content: "export const a = 1", isError: false, durationMs: 4 },
      { type: "agent.subagent_output", ...ids, subagentId: "toolu_task", kind: "text", text: "a.ts exports a." },
    );
    expect(run?.steps).toEqual([
      { kind: "text", text: "<think>Where?</think>", streaming: false },
      { kind: "tool", id: "toolu_read", name: "Read", input: { file_path: "a.ts" }, result: "export const a = 1", isError: false, durationMs: 4 },
      { kind: "text", text: "a.ts exports a.", streaming: false },
    ]);
    expect(turn.parts.some((part) => part.kind === "tool" && part.id === "toolu_read")).toBe(false);
  });

  it("keeps OMP's recent window on the run while it runs", () => {
    const { run } = steps({
      type: "agent.subagent_progress",
      ...ids,
      subagentId: "toolu_task",
      summary: "found it",
      recentTools: ["read"],
      recentOutput: ["found it"],
    });
    expect(run).toMatchObject({ steps: [], recentTools: ["read"], recentOutput: ["found it"] });
  });
});
