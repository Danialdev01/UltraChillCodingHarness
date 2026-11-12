import { describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import type { Principal } from "./auth.js";
import type { Publication } from "./bus.js";
import { ChoiceWaiters, type HarnessAvailability } from "./choices.js";
import type { EngineResult } from "./engine.js";
import type { EventStore } from "./eventstore.js";
import { SubagentRunner, type SubagentDeps } from "./subagents.js";

const PARENT = "44444444-4444-4444-4444-444444444444";
const CHILD = "66666666-6666-4666-8666-666666666666";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const USER = "11111111-1111-1111-1111-111111111111";
const TURN = "55555555-5555-4555-8555-555555555555";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

const harnesses: HarnessAvailability[] = [
  { provider: "claude", label: "Claude Code", usable: true, blocker: null, custom: false },
  { provider: "codex", label: "Codex", usable: true, blocker: null, custom: false },
  { provider: "omp", label: "Custom (OpenRouter)", usable: true, blocker: null, custom: true },
];

/**
 * A runner whose child session answers each turn it is started with by the
 * next of `turns`: the events its bus would carry.
 */
function runner(turns: DomainEvent[][], overrides: Partial<SubagentDeps> = {}, extraRows: unknown[][] = []) {
  const rows: unknown[][] = [
    [{ id: PARENT, projectId: PROJECT, provider: "claude", createdByUserId: USER, parentThreadId: null, creator: USER }],
    [{ model: "claude-sonnet-5-5" }],
    ...extraRows,
  ];
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
  chain.limit = () => Promise.resolve(rows.shift() ?? []);
  const onParent: DomainEvent[] = [];
  const store = {
    append: async (_target: unknown, batch: DomainEvent[]) => {
      onParent.push(...batch);
      return [];
    },
  } as unknown as EventStore;
  const listeners = new Set<(p: Publication) => void>();
  const bus = {
    subscribe: (_topic: unknown, listener: (p: Publication) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const commands: Command[] = [];
  const play = (events: DomainEvent[]) =>
    setTimeout(() => {
      for (const event of events) for (const listener of [...listeners]) listener({ seq: null, projectId: PROJECT, threadId: CHILD, event });
    }, 5);
  const dispatch = async (_principal: Principal, command: Command): Promise<EngineResult> => {
    commands.push(command);
    if (command.type === "thread.create") {
      return {
        ok: true,
        events: [
          {
            id: "1",
            threadId: CHILD,
            projectId: PROJECT,
            seq: 0,
            createdAt: "",
            event: { type: "thread.created", threadId: CHILD, projectId: PROJECT, title: "x", hash: "child1234567" },
          },
        ],
      };
    }
    if (command.type === "thread.send" || command.type === "thread.switch_harness") play(turns.shift() ?? []);
    return { ok: true, events: [] };
  };
  const choices = new ChoiceWaiters();
  const allowed: string[] = [];
  const run = new SubagentRunner({
    db: { select: () => chain } as unknown as Database,
    store,
    bus,
    dispatch,
    harnesses: async () => harnesses,
    catalogue: async () => [{ id: "moonshotai/kimi-k2", name: "Kimi K2" }],
    customProvider: "omp",
    claimCall: async () => ({ turnId: TURN, toolUseId: "toolu_1" }),
    choices,
    allowAllFor: (threadId) => allowed.push(threadId),
    onError: (error) => {
      throw error;
    },
    ...overrides,
  });
  return { run, onParent, commands, choices, allowed };
}

const reply = (text: string): DomainEvent[] => [
  { type: "agent.text_delta", threadId: CHILD, turnId: TURN, text: "Looking…" },
  { type: "agent.tool_use", threadId: CHILD, turnId: TURN, toolUseId: "t", name: "Read", input: {} },
  { type: "agent.text_delta", threadId: CHILD, turnId: TURN, text },
  { type: "agent.turn_completed", threadId: CHILD, turnId: TURN, stopReason: "end_turn", usage, costUsd: 0.01 },
];

describe("SubagentRunner", () => {
  it("runs a Codex model on Codex in a child session, and reports to the parent", async () => {
    const { run, onParent, commands, allowed } = runner([reply("Found the race in retry.ts.")]);
    const outcome = await run.spawn(PARENT, USER, { description: "Research", task: "Find the bug", model: "gpt6 sol" }, new AbortController().signal);
    expect(outcome).toEqual({ text: "Found the race in retry.ts." });
    expect(commands[0]).toMatchObject({ type: "thread.create", parentThreadId: PARENT, title: "Research" });
    expect(commands[1]).toMatchObject({ type: "thread.send", threadId: CHILD, provider: "codex", model: "gpt-6-sol" });
    expect((commands[1] as { text: string }).text).toContain("<task>\nFind the bug\n</task>");
    expect(allowed).toEqual([CHILD]);
    expect(onParent[0]).toMatchObject({
      type: "agent.subagent_started",
      threadId: PARENT,
      turnId: TURN,
      parentToolUseId: "toolu_1",
      provider: "codex",
      model: "gpt-6-sol",
      childThreadId: CHILD,
      childHash: "child1234567",
    });
    expect(onParent.at(-1)).toMatchObject({
      type: "agent.subagent_finished",
      status: "completed",
      result: "Found the race in retry.ts.",
      toolCalls: 1,
      usage,
      costUsd: 0.01,
    });
  });

  it("inherits the parent's harness and model when none is named", async () => {
    const { run, commands } = runner([reply("done")]);
    await run.spawn(PARENT, USER, { description: "Dev", task: "Do it" }, new AbortController().signal);
    expect(commands[1]).toMatchObject({ type: "thread.send", provider: "claude", model: "claude-sonnet-5-5" });
  });

  it("answers why when the model routes nowhere, starting nothing", async () => {
    const { run, commands } = runner([]);
    const outcome = await run.spawn(PARENT, USER, { description: "x", task: "y", model: "no such model" }, new AbortController().signal);
    expect(outcome).toMatchObject({ error: expect.stringContaining("no OpenRouter model matches") });
    expect(commands).toEqual([]);
  });

  it("asks the parent how to carry on after a limit, and switches the child to the answer", async () => {
    const limited: DomainEvent[] = [
      { type: "agent.turn_failed", threadId: CHILD, turnId: TURN, error: "You've hit your usage limit", limit: true },
    ];
    const { run, onParent, commands, choices } = runner([limited, reply("Carried on and finished.")]);
    const done = run.spawn(PARENT, USER, { description: "Dev", task: "Build it", model: "opus 5.5" }, new AbortController().signal);
    const deadline = Date.now() + 2_000;
    while (!onParent.some((e) => e.type === "agent.choice_requested") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const card = onParent.find((e) => e.type === "agent.choice_requested");
    expect(card).toMatchObject({ kind: "subagent_limit", childThreadId: CHILD, provider: "claude" });
    if (card?.type !== "agent.choice_requested") throw new Error("no card");
    expect(card.options.map((option) => option.id)).toEqual(["codex", "custom"]);
    expect(choices.answer(card.requestId, { optionId: "custom", model: "moonshotai/kimi-k2" })).toBe(true);
    expect(await done).toEqual({ text: "Carried on and finished." });
    expect(commands.at(-1)).toMatchObject({
      type: "thread.switch_harness",
      threadId: CHILD,
      targetProvider: "omp",
      model: "moonshotai/kimi-k2",
      reason: "limit",
    });
    expect(onParent).toContainEqual(
      expect.objectContaining({ type: "agent.choice_resolved", requestId: card.requestId, optionId: "custom" }),
    );
  });

  it("stops the child when the parent's call goes away", async () => {
    const { run, commands } = runner([[]]);
    const controller = new AbortController();
    const done = run.spawn(PARENT, USER, { description: "x", task: "y" }, controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await done).toEqual({ error: "the subagent was stopped" });
    expect(commands.at(-1)).toEqual({ type: "thread.cancel", threadId: CHILD });
  });
});

describe("background subagents", () => {
  it("returns an ID before completion and survives the spawn connection closing", async () => {
    const { run, commands, onParent } = runner([reply("Background result")]);
    const signal = new AbortController();
    const outcome = await run.spawn(PARENT, USER, { description: "Review", task: "Inspect", model: "gpt6 sol", background: true }, signal.signal);
    expect(outcome).toHaveProperty("text");
    const info = JSON.parse((outcome as { text: string }).text);
    expect(info).toMatchObject({ sessionId: CHILD, provider: "codex", status: "running" });
    expect(onParent.some((e) => e.type === "agent.subagent_finished")).toBe(false);
    signal.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(commands.some((c) => c.type === "thread.cancel")).toBe(false);
    expect(onParent.at(-1)).toMatchObject({ type: "agent.subagent_finished", status: "completed", result: "Background result" });
  });
  it("stops a background child when its parent is explicitly cancelled", async () => {
    const { run, onParent, commands } = runner([]);
    await run.spawn(PARENT, USER, { description: "Review", task: "Inspect", model: "gpt6 sol", background: true }, new AbortController().signal);
    run.cancel(PARENT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(commands).toContainEqual({ type: "thread.cancel", threadId: CHILD });
    expect(onParent.at(-1)).toMatchObject({ type: "agent.subagent_finished", status: "aborted" });
  });
});

describe("automatic same-model fallback", () => {
  const catalogue = async () => [{ id: "anthropic/claude-opus-5.5" }];
  const limited: DomainEvent[] = [{ type: "agent.turn_failed", threadId: CHILD, turnId: TURN, error: "subscription limit", limit: true }];
  it("starts on OMP above the quota threshold without attempting Claude", async () => {
    const { run, commands, onParent } = runner([reply("done")], { catalogue,
      harnesses: async () => harnesses.map((h) => ({ ...h, ...(h.provider === "claude" ? { usedPercent: 95 } : {}) })) });
    expect(await run.spawn(PARENT, USER, { description: "Review", task: "Inspect", model: "opus 5.5" }, new AbortController().signal)).toEqual({ text: "done" });
    expect(commands[1]).toMatchObject({ type: "thread.send", provider: "omp", model: "anthropic/claude-opus-5.5" });
    expect(onParent[0]).toMatchObject({ routing: expect.stringContaining("95% exceeds 90%") });
  });
  it("switches an established child session automatically after a limit", async () => {
    const { run, commands, onParent } = runner([limited, reply("continued")], { catalogue }, [[{ provider: "claude" }]]);
    expect(await run.spawn(PARENT, USER, { description: "Review", task: "Inspect", model: "opus 5.5" }, new AbortController().signal)).toEqual({ text: "continued" });
    expect(commands.at(-1)).toMatchObject({ type: "thread.switch_harness", targetProvider: "omp", model: "anthropic/claude-opus-5.5" });
    expect(onParent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.subagent_routed", provider: "omp" })]));
    expect(onParent.some((e) => e.type === "agent.choice_requested")).toBe(false);
  });
  it("can retry on OMP when the CLI rejected the model before creating a session", async () => {
    const rejected: DomainEvent[] = [{ type: "agent.turn_failed", threadId: CHILD, turnId: TURN, error: "model is not available" }];
    const { run, commands } = runner([rejected, reply("done")], { catalogue }, [[{ provider: null }]]);
    await run.spawn(PARENT, USER, { description: "Review", task: "Inspect", model: "opus 5.5" }, new AbortController().signal);
    expect(commands.at(-1)).toMatchObject({ type: "thread.send", provider: "omp", model: "anthropic/claude-opus-5.5" });
  });
});
