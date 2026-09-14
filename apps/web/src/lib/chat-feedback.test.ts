import { describe, expect, it } from "vitest";
import { readRatings, transcript, writeRating, type RatingStore } from "./chat-feedback.js";
import type { ChatMessage } from "./chat-messages.js";

function memory(): RatingStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("ratings", () => {
  it("are kept per conversation and per turn", () => {
    const store = memory();
    writeRating("t1", "a", "up", store);
    writeRating("t1", "b", "down", store);
    writeRating("t2", "a", "down", store);
    expect(readRatings("t1", store)).toEqual({ a: "up", b: "down" });
    expect(readRatings("t2", store)).toEqual({ a: "down" });
  });

  it("clear with null and ignore junk in storage", () => {
    const store = memory();
    writeRating("t1", "a", "up", store);
    expect(writeRating("t1", "a", null, store)).toEqual({});
    store.data.set("ucch:feedback:t1", '{"a":"sideways","b":"up"}');
    expect(readRatings("t1", store)).toEqual({ b: "up" });
    store.data.set("ucch:feedback:t1", "not json");
    expect(readRatings("t1", store)).toEqual({});
  });

  it("survive having no storage at all", () => {
    expect(readRatings("t1", null)).toEqual({});
    expect(writeRating("t1", "a", "up", null)).toEqual({ a: "up" });
  });
});

describe("transcript", () => {
  const assistant = (parts: ChatMessage["parts"], extra: Partial<ChatMessage> = {}): ChatMessage => ({
    role: "assistant",
    text: "",
    parts,
    reasoning: "secret plan",
    streaming: false,
    startedAt: null,
    completedAt: null,
    ...extra,
  });

  it("is the conversation without the work behind it", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        text: "what is this?",
        attachments: [{ name: "notes.md", size: 1, type: "text/markdown", uploadId: "u1" }],
        parts: [],
        reasoning: "",
        streaming: false,
        startedAt: null,
        completedAt: null,
      },
      assistant([
        { kind: "text", text: "<think>look first</think>", streaming: false },
        { kind: "tool", id: "1", name: "read", input: {}, result: "x", isError: false, durationMs: 1 },
        { kind: "text", text: "It is **BrainPanel**.", streaming: false },
      ]),
      assistant([], { error: "boom" }),
    ];
    expect(transcript(messages)).toBe(
      "User:\nwhat is this?\n[attached: notes.md]\n\nAssistant:\nIt is **BrainPanel**.\n\nAssistant:\n[failed: boom]",
    );
  });
});
