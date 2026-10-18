import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import {
  agentStatus,
  DONE_MS,
  nextExpiry,
  reduceActivity,
  type ActivityState,
} from "./agent-activity.js";

const P = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const TURN = "44444444-4444-4444-8444-444444444444";
const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

const started = (threadId: string) =>
  ({ type: "turn.started", threadId, turnId: TURN }) as DomainEvent;
const completed = (threadId: string, stopReason: string | null = "end_turn") =>
  ({ type: "agent.turn_completed", threadId, turnId: TURN, stopReason, usage, costUsd: 0 }) as DomainEvent;
const failed = (threadId: string) =>
  ({ type: "agent.turn_failed", threadId, turnId: TURN, error: "boom" }) as DomainEvent;

function fold(events: DomainEvent[], at = 1_000): ActivityState {
  return events.reduce<ActivityState>((s, e) => reduceActivity(s, P, e, at), {});
}

describe("agent activity", () => {
  it("is working while a turn runs", () => {
    expect(agentStatus(fold([started(A)])[P], false, 1_000)).toBe("working");
  });

  it("is done for ten seconds after the turn finishes, then idle", () => {
    const state = fold([started(A), completed(A)], 1_000);
    expect(agentStatus(state[P], false, 1_000 + DONE_MS - 1)).toBe("done");
    expect(agentStatus(state[P], false, 1_000 + DONE_MS)).toBe("idle");
  });

  it("keeps working until every thread in the project has finished", () => {
    const state = fold([started(A), started(B), completed(A)]);
    expect(agentStatus(state[P], false, 1_000)).toBe("working");
    expect(agentStatus(reduceActivity(state, P, completed(B), 1_000)[P], false, 1_000)).toBe("done");
  });

  it("is not marked done when the turn failed or was cancelled", () => {
    expect(agentStatus(fold([started(A), failed(A)])[P], false, 1_000)).toBe("error");
    expect(agentStatus(fold([started(A), completed(A, "cancelled")])[P], false, 1_000)).toBe("idle");
  });

  it("marks a turn cut off by a limit as an error, not done", () => {
    for (const reason of ["max_iterations", "max_tokens", "length", "error_max_turns"]) {
      expect(agentStatus(fold([started(A), completed(A, reason)])[P], false, 1_000)).toBe("error");
    }
  });

  it("holds the error past the done window, until the next turn starts", () => {
    const state = fold([started(A), failed(A)], 1_000);
    expect(agentStatus(state[P], false, 1_000 + 60 * 60_000)).toBe("error");
    expect(agentStatus(reduceActivity(state, P, started(A), 2_000)[P], false, 2_000)).toBe("working");
  });

  it("shows working over an error from another session", () => {
    const state = fold([started(A), started(B), failed(A)]);
    expect(agentStatus(state[P], false, 1_000)).toBe("working");
    expect(agentStatus(reduceActivity(state, P, completed(B), 1_000)[P], false, 1_000)).toBe("error");
  });

  it("trusts the page's snapshot of a failed turn", () => {
    expect(agentStatus(undefined, false, 0, true)).toBe("error");
    expect(agentStatus(undefined, true, 0, true)).toBe("working");
  });

  it("dates the done mark to the event, so replayed history stays quiet", () => {
    const state = fold([started(A), completed(A)], 1_000);
    expect(agentStatus(state[P], false, 1_000 + 60 * 60_000)).toBe("idle");
  });

  it("trusts the page's snapshot until the socket says otherwise", () => {
    expect(agentStatus(undefined, true, 0)).toBe("working");
    // Running when the page loaded, on a thread this tab never saw start.
    const state = reduceActivity({}, P, completed(A), 1_000);
    expect(agentStatus(state[P], true, 1_000)).toBe("done");
  });

  it("ignores everything else", () => {
    const state = fold([started(A)]);
    const other = { type: "agent.text_delta", threadId: A, turnId: TURN, text: "x" } as DomainEvent;
    expect(reduceActivity(state, P, other, 1_000)).toBe(state);
  });

  it("knows when the next done mark lapses", () => {
    const state = fold([started(A), completed(A)], 1_000);
    expect(nextExpiry(state, 1_000)).toBe(1_000 + DONE_MS);
    expect(nextExpiry(state, 1_000 + DONE_MS)).toBeNull();
  });
});
