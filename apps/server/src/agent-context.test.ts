import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { lastWasCompaction, openRequests } from "./agent.js";
import { readingOf, usageEventOf } from "./engine.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("the kept reading (plan2 §1.4)", () => {
  it("round-trips a context.usage through the thread's column", () => {
    const event: Extract<DomainEvent, { type: "context.usage" }> = {
      type: "context.usage",
      threadId: THREAD,
      turnId: TURN,
      usedTokens: 20_339,
      windowTokens: 1_000_000,
      thresholdTokens: 967_000,
      status: "complete",
      cacheExpiresAt: "2026-11-21T11:00:00.000Z",
      cacheTtlMs: 3_600_000,
      cachedTokens: 0,
      cacheHitRatio: 0,
      harness: "claude",
      model: "claude-opus-5-5",
      at: "2026-11-21T10:00:04.000Z",
    };
    const reading = readingOf(event);
    expect(reading).toEqual({
      usedTokens: 20_339,
      windowTokens: 1_000_000,
      compactThreshold: 967_000,
      cacheExpiresAt: "2026-11-21T11:00:00.000Z",
      cacheTtlMs: 3_600_000,
      cachedTokens: 0,
      cacheHitRatio: 0,
      status: "complete",
      harness: "claude",
      model: "claude-opus-5-5",
      at: "2026-11-21T10:00:04.000Z",
      turnId: TURN,
    });
    expect(usageEventOf(THREAD, reading)).toEqual(event);
  });

  it("calls an old reading with no figure unavailable, never 0", () => {
    const reading = readingOf({ type: "context.usage", threadId: THREAD, usedTokens: null, windowTokens: null, thresholdTokens: null });
    expect(reading).toMatchObject({ usedTokens: null, status: "unavailable", harness: null });
  });
});

describe("the idle compaction's view of the log (plan2 §3.3)", () => {
  const permission = (requestId: string): DomainEvent => ({
    type: "agent.permission_requested",
    threadId: THREAD,
    turnId: TURN,
    requestId,
    toolUseId: "t1",
    toolName: "Bash",
    input: {},
    description: null,
  });
  const choice = (requestId: string): DomainEvent => ({
    type: "agent.choice_requested",
    threadId: THREAD,
    requestId,
    kind: "harness_limit",
    title: "t",
    options: [],
  });

  it("sees a choice card nobody answered, and none a new turn overtook or a turn's end closed", () => {
    expect(openRequests([choice("c1")])).toBe(true);
    expect(openRequests([choice("c1"), { type: "agent.choice_resolved", threadId: THREAD, requestId: "c1", optionId: null }])).toBe(false);
    expect(openRequests([choice("c1"), { type: "turn.started", threadId: THREAD, turnId: TURN, provider: "claude" }])).toBe(false);
    expect(openRequests([permission("p1")])).toBe(true);
    expect(
      openRequests([permission("p1"), { type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "x" }]),
    ).toBe(false);
  });

  it("knows a session was just compacted, and not once something was said after", () => {
    const finished: DomainEvent = { type: "thread.compaction_finished", threadId: THREAD, method: "compact" };
    expect(lastWasCompaction([finished])).toBe(true);
    expect(lastWasCompaction([{ ...finished, error: "boom" }])).toBe(false);
    expect(lastWasCompaction([finished, { type: "user.message", threadId: THREAD, text: "go on" }])).toBe(false);
    expect(lastWasCompaction([])).toBe(false);
  });
});
