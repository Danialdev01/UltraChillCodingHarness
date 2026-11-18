import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { conversationRecap, exchangesOf, recentExchanges } from "./thread-transcript.js";

const T = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const user = (text: string) => ({ event: { type: "user.message", threadId: T, text } as DomainEvent });
const reply = (...content: unknown[]) => ({ event: { type: "agent.message", threadId: T, turnId: TURN, content } as DomainEvent });

describe("thread transcripts", () => {
  it("pairs each prompt with the text it got back, leaving tools and thinking out", () => {
    const exchanges = exchangesOf([
      user("plan my trip"),
      reply({ type: "thinking", thinking: "hmm" }, { type: "text", text: "Take the MRT." }),
      reply({ type: "tool_use", id: "t", name: "x", input: {} }),
      reply({ type: "text", text: "Done." }),
      user("add Subang Jaya"),
    ]);
    expect(exchanges).toEqual([
      { prompt: "plan my trip", reply: "Take the MRT.\n\nDone." },
      { prompt: "add Subang Jaya", reply: "" },
    ]);
  });

  it("keeps the newest exchanges whole within the budget", () => {
    const exchanges = [{ prompt: "a", reply: "x".repeat(50) }, { prompt: "b", reply: "y".repeat(10) }];
    const kept = recentExchanges(exchanges, 2, 20);
    expect(kept.at(-1)).toEqual({ prompt: "b", reply: "y".repeat(10) });
    expect(kept.reduce((n, e) => n + e.prompt.length + e.reply.length, 0)).toBeLessThanOrEqual(21);
  });

  it("recaps a conversation for a new session, and nothing for an empty one", () => {
    expect(conversationRecap([])).toBeNull();
    const recap = conversationRecap([{ prompt: "plan my trip", reply: "Take the MRT." }])!;
    expect(recap).toContain("no longer available");
    expect(recap).toContain("User:\nplan my trip");
    expect(recap).toContain("Assistant:\nTake the MRT.");
  });
});
