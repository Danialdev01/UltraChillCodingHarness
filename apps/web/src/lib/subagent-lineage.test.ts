import { describe, expect, it } from "vitest";

import type { ChatMessage, ToolPart } from "./chat-messages.js";
import {
  followUpHarness,
  lineageKey,
  lineageOf,
  partitionLineage,
  SUBAGENT_LINGER_MS,
  subagentHref,
  type LineageEntry,
} from "./subagent-lineage.js";

function call(overrides: Partial<ToolPart>): ToolPart {
  return {
    kind: "tool",
    id: "call_1",
    name: "Task",
    input: { description: "Find it", prompt: "Find the cache, in detail", subagent_type: "Explore" },
    result: null,
    isError: false,
    durationMs: null,
    ...overrides,
  } as ToolPart;
}

function assistant(parts: ToolPart[]): ChatMessage {
  return { role: "assistant", text: "", parts, reasoning: "", streaming: false } as unknown as ChatMessage;
}

function entry(id: string, status: LineageEntry["run"]["status"]): LineageEntry {
  return {
    callId: `call_${id}`,
    run: {
      id,
      agent: "scout",
      description: id,
      model: null,
      status,
      summary: null,
      toolCalls: null,
      durationMs: null,
      costUsd: null,
      result: null,
      steps: [],
      prompt: null,
    },
  };
}

describe("lineageOf", () => {
  it("carries a built-in call's prompt, agent and answer", () => {
    const [only] = lineageOf([assistant([call({ result: "It is in cache.ts.", durationMs: 900 })])]);
    expect(only?.run).toMatchObject({
      agent: "Explore",
      description: "Find it",
      prompt: "Find the cache, in detail",
      result: "It is in cache.ts.",
      status: "completed",
    });
    expect(only?.run.childHash).toBeUndefined();
  });

  it("carries a ucch_agent run's session and prompt", () => {
    const [only] = lineageOf([
      assistant([
        call({
          name: "ucch_agent",
          input: { description: "Research", task: "Look closely" },
          subagents: [
            {
              id: "s1",
              agent: "Codex",
              description: "Research",
              model: "gpt-6-sol",
              status: "running",
              summary: "reading",
              steps: [],
              toolCalls: 1,
              durationMs: null,
              costUsd: null,
              result: null,
              provider: "codex",
              childHash: "child1234567",
            },
          ],
        }),
      ]),
    ]);
    expect(only?.run).toMatchObject({ childHash: "child1234567", prompt: "Look closely", provider: "codex" });
  });
});

describe("partitionLineage", () => {
  const now = 1_000_000;

  it("keeps running ones, and ones back within the linger, among the active", () => {
    const running = entry("a", "running");
    const fresh = entry("b", "completed");
    const old = entry("c", "completed");
    const before = entry("d", "failed");
    const finishedAt = new Map([
      [lineageKey(fresh), now - SUBAGENT_LINGER_MS + 1],
      [lineageKey(old), now - SUBAGENT_LINGER_MS],
      [lineageKey(before), 0],
    ]);
    const { active, done } = partitionLineage([running, fresh, old, before], finishedAt, now);
    expect(active.map((e) => e.run.id)).toEqual(["a", "b"]);
    // Newest first.
    expect(done.map((e) => e.run.id)).toEqual(["d", "c"]);
  });

  it("puts a finished one it has no date for straight into Done", () => {
    const { active, done } = partitionLineage([entry("x", "aborted")], new Map(), now);
    expect(active).toEqual([]);
    expect(done.map((e) => e.run.id)).toEqual(["x"]);
  });
});

describe("subagentHref", () => {
  const where = { ws: "ws1", projectHash: "proj1", parentHash: "parent1", kind: "project" };

  it("goes to a ucch_agent subagent's own session", () => {
    const e = entry("s1", "completed");
    e.run.childHash = "child1";
    expect(subagentHref(e, where)).toBe("/ws1/p/proj1/child1");
  });

  it("opens a built-in over its parent's session", () => {
    expect(subagentHref(entry("s1", "completed"), where)).toBe("/ws1/p/proj1/parent1?agent=call_s1%3As1");
  });

  it("has nowhere to go outside a project workspace", () => {
    expect(subagentHref(entry("s1", "completed"), { ...where, kind: "session" })).toBeNull();
  });
});

describe("followUpHarness", () => {
  const on = (harness: string, run: Partial<LineageEntry["run"]> = {}): LineageEntry => {
    const base = entry("s1", "completed")
    return { ...base, harness, run: { ...base.run, ...run } }
  }
  it("routes a Codex worker and a continuable Claude Code agent through their parent", () => {
    expect(followUpHarness(on("codex"))).toBe("codex")
    expect(followUpHarness(on("claude", { resumeHandle: "a454c450ac8feab62" }))).toBe("claude")
  })
  it("offers no chat box where the parent cannot reach the agent", () => {
    // No handle reported, OMP's own, or a ucch_agent one with a session of its own.
    expect(followUpHarness(on("claude"))).toBeNull()
    expect(followUpHarness(on("omp"))).toBeNull()
    expect(followUpHarness(on("claude", { provider: "claude", childHash: "abc", resumeHandle: "x" }))).toBeNull()
    expect(followUpHarness(on("codex", { provider: "claude", resumeHandle: "x" }))).toBeNull()
  })
})
