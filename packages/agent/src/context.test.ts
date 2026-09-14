import { describe, expect, it } from "vitest";
import type { ChatMessage, Complete, CompletionResult } from "./completion.js";
import { compact, measure, pruneToolResults, summaryMessage, usableTokens } from "./context.js";

const reply = (text: string): CompletionResult => ({
  text,
  reasoning: "",
  toolCalls: [],
  annotations: [],
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0.002,
});

const toolResult = (id: string, bytes: number): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content: "x".repeat(bytes),
});

/** A system message, a user turn, then `count` sizeable tool results. */
function conversation(count: number, bytes = 20_000): ChatMessage[] {
  return [
    { role: "system", content: "rules" },
    { role: "user", content: "do the thing" },
    ...Array.from({ length: count }, (_, i) => [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          { id: `c${i}`, type: "function" as const, function: { name: "read_file", arguments: "{}" } },
        ],
      },
      toolResult(`c${i}`, bytes),
    ]).flat(),
  ];
}

describe("measure", () => {
  it("counts content, spans and tool-call arguments", () => {
    const tokens = measure([
      { role: "system", content: [{ type: "text", text: "a".repeat(400) }] },
      {
        role: "assistant",
        content: "b".repeat(400),
        tool_calls: [
          { id: "c", type: "function", function: { name: "grep", arguments: "d".repeat(396) } },
        ],
      },
    ]);
    // 400 + 400 + 4 ("grep") + 396 characters, at four to the token.
    expect(tokens).toBe(300);
  });
});

describe("usableTokens", () => {
  it("is null when the catalogue publishes no window", () => {
    // Null is a real answer: a guessed ceiling either compacts a thread that
    // was fine or fails to compact one that was not.
    expect(usableTokens({ contextLength: null, reserveTokens: 1000 })).toBeNull();
    expect(usableTokens({ contextLength: 0, reserveTokens: 1000 })).toBeNull();
  });

  it("holds back the flat reserve on a large window", () => {
    expect(usableTokens({ contextLength: 1_000_000, reserveTokens: 24_000 })).toBe(976_000);
  });

  it("caps the reserve at a fifth of a small one", () => {
    // Holding back 24k of a 32k model would leave a quarter of it usable and
    // compact threads that were never in trouble.
    expect(usableTokens({ contextLength: 32_000, reserveTokens: 24_000 })).toBe(25_600);
    expect(usableTokens({ contextLength: 100_000, reserveTokens: 24_000 })).toBe(80_000);
  });
});

describe("pruneToolResults", () => {
  it("brings a heavy conversation under a reachable target", () => {
    const messages = conversation(12);
    const before = measure(messages);
    const target = Math.floor(before * 0.6);

    const { messages: pruned, reclaimed } = pruneToolResults(messages, target);
    expect(reclaimed).toBeGreaterThan(0);
    expect(measure(pruned)).toBeLessThanOrEqual(target);
  });

  it("stops once it is under, rather than pruning everything it could", () => {
    const messages = conversation(12);
    const target = Math.floor(measure(messages) * 0.8);
    const { messages: pruned } = pruneToolResults(messages, target);
    // The oldest went; the seventh-from-last was never needed and is intact.
    expect(pruned[3]).not.toEqual(messages[3]);
    expect(pruned.at(-13)).toEqual(messages.at(-13));
  });

  it("cannot go below the results it is protecting", () => {
    // Six recent results at 20 KB each is the floor, and it is a floor by
    // design: below it the turn keeps its tokens and loses its work.
    const messages = conversation(12);
    const { messages: pruned } = pruneToolResults(messages, 0);
    expect(measure(pruned)).toBeGreaterThan(6 * 20_000 / 4);
  });

  it("leaves the most recent results alone", () => {
    const messages = conversation(12);
    const { messages: pruned } = pruneToolResults(messages, 0);
    // The last six are what the model is working from -- the file it is about
    // to edit, the output it is about to fix.
    expect(pruned.at(-1)).toEqual(messages.at(-1));
    expect(pruned.at(-3)).toEqual(messages.at(-3));
    // And something older did get cut.
    expect(pruned[3]).not.toEqual(messages[3]);
  });

  it("says what it elided, so the model can ask again", () => {
    const { messages: pruned } = pruneToolResults(conversation(12), 0);
    expect(String(pruned[3]!.content)).toContain("call the tool again");
  });

  it("changes nothing when there is too little to reclaim", () => {
    // Pruning rewrites the middle of the prefix and so costs the cache from
    // that point. Spending that to save a few hundred tokens is a loss.
    const messages = conversation(12, 300);
    const { messages: out, reclaimed } = pruneToolResults(messages, 0);
    expect(reclaimed).toBe(0);
    expect(out).toEqual(messages);
  });

  it("never touches the system prompt", () => {
    const messages = conversation(12);
    const { messages: pruned } = pruneToolResults(messages, 0);
    expect(pruned[0]).toEqual(messages[0]);
  });
});

describe("compact", () => {
  const run = async (messages: ChatMessage[], complete: Complete) =>
    compact({
      messages,
      apiKey: "k",
      model: "cheap/model",
      signal: new AbortController().signal,
      complete,
    });

  it("summarises the older half and reports what it replaced", async () => {
    const messages = conversation(10);
    const seen: ChatMessage[][] = [];
    const outcome = await run(messages, async (request) => {
      seen.push(request.messages);
      return reply("Read index.ts; the port is 3000.");
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.summary).toBe("Read index.ts; the port is 3000.");
    expect(outcome!.replacedThrough).toBeGreaterThan(1);
    expect(outcome!.replacedThrough).toBeLessThan(messages.length);
    // Billed, not absorbed: the summary is a model call the turn paid for.
    expect(outcome!.costUsd).toBe(0.002);
    expect(outcome!.usage.outputTokens).toBe(20);
  });

  it("asks the cheap model, never the turn's own", async () => {
    let asked = "";
    await run(conversation(10), async (request) => {
      asked = request.model;
      return reply("summary");
    });
    expect(asked).toBe("cheap/model");
  });

  it("never cuts between an assistant's call and its result", async () => {
    // A `tool` message whose matching call has been summarised away is a
    // dangling reference, and several providers reject it outright.
    const messages = conversation(10);
    const outcome = await run(messages, async () => reply("summary"));
    expect(messages[outcome!.replacedThrough]!.role).not.toBe("tool");
  });

  it("leaves the system prompt out of the transcript it summarises", async () => {
    let transcript = "";
    await run(conversation(10), async (request) => {
      transcript = String(request.messages[1]!.content);
      return reply("summary");
    });
    expect(transcript).not.toContain("rules");
    expect(transcript).toContain("[user] do the thing");
  });

  it("declines a conversation too short to be worth folding", async () => {
    const outcome = await run(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "hi" },
      ],
      async () => reply("summary"),
    );
    expect(outcome).toBeNull();
  });

  it("declines when the summariser returns nothing", async () => {
    expect(await run(conversation(10), async () => reply("   "))).toBeNull();
  });
});

describe("summaryMessage", () => {
  it("replays as a labelled user message, never as a second system prompt", () => {
    // The system prompt is the cached prefix and must stay byte-identical,
    // and a system message partway through is handled inconsistently.
    const message = summaryMessage("what happened");
    expect(message.role).toBe("user");
    expect(String(message.content)).toContain("summarised");
    expect(String(message.content)).toContain("what happened");
  });
});
