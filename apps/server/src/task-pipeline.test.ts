import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TASK_AUTO_RUN,
  type Command,
  type DomainEvent,
  type ProjectTask,
  type TaskSettings,
} from "@ucch/protocol";
import { EventBus } from "./bus.js";
import type { EngineResult } from "./engine.js";
import { TaskPipeline, parseVerdict } from "./task-pipeline.js";
import type { TaskProgress } from "./tasks.js";

const PROJECT = randomUUID();

function card(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: randomUUID(),
    title: "Add a dark mode toggle",
    description: "In the header",
    references: [{ kind: "url", url: "https://example.com/spec" }],
    stage: "research",
    status: "idle",
    position: 0,
    research: null,
    verification: null,
    feedback: [],
    threadId: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A board of one card, and an engine whose turns answer from a script: each
 * `thread.send` is answered on the bus the way the agent reactor would.
 */
/** A reply that is never a turn: the message is dequeued instead. */
const DEQUEUED = Symbol("dequeued");

function harness(task: ProjectTask, replies: (text: string) => string | Error | null | typeof DEQUEUED) {
  let current = task;
  const bus = new EventBus();
  const sent: Extract<Command, { type: "thread.send" }>[] = [];
  const titles: string[] = [];
  const cancelled: string[] = [];

  const emit = (threadId: string, event: DomainEvent) =>
    bus.publish({ seq: null, projectId: PROJECT, threadId, event });

  const dispatch = vi.fn(async (_principal: unknown, command: Command): Promise<EngineResult> => {
    if (command.type === "thread.create") {
      titles.push(command.title ?? "");
      const threadId = randomUUID();
      return {
        ok: true,
        events: [
          {
            id: "1",
            threadId,
            projectId: PROJECT,
            seq: 1,
            createdAt: new Date().toISOString(),
            event: { type: "thread.created", threadId, projectId: PROJECT, title: command.title ?? "" },
          },
        ],
      };
    }
    if (command.type === "thread.cancel") {
      cancelled.push(command.threadId);
      emit(command.threadId, {
        type: "agent.turn_completed",
        threadId: command.threadId,
        turnId: randomUUID(),
        stopReason: "cancelled",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
      } as unknown as DomainEvent);
      return { ok: true, events: [] };
    }
    if (command.type === "thread.send") {
      sent.push(command);
      const reply = replies(command.text);
      const turnId = randomUUID();
      const { threadId } = command;
      setTimeout(() => {
        if (reply === null) return; // a turn that never ends on its own
        if (reply === DEQUEUED) {
          emit(threadId, { type: "turn.dequeued", threadId, reason: "error" });
          return;
        }
        if (reply instanceof Error) {
          emit(threadId, { type: "agent.turn_failed", threadId, turnId, error: reply.message });
          return;
        }
        emit(threadId, { type: "agent.text_delta", threadId, turnId, text: "Looking around. " });
        emit(threadId, {
          type: "agent.tool_use",
          threadId,
          turnId,
          toolUseId: "x",
          name: "read",
          input: {},
        } as unknown as DomainEvent);
        emit(threadId, { type: "agent.text_delta", threadId, turnId, text: reply });
        emit(threadId, {
          type: "agent.turn_completed",
          threadId,
          turnId,
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0,
        } as unknown as DomainEvent);
      }, 0);
      return { ok: true, events: [] };
    }
    return { ok: true, events: [] };
  });

  const settings: TaskSettings = { provider: "claude", model: null, autoRun: DEFAULT_TASK_AUTO_RUN };
  const allowed: string[] = [];
  const pipeline = new TaskPipeline({
    tasks: {
      get: async () => current,
      progress: async (_p: string, _t: string, progress: TaskProgress) => {
        current = { ...current, ...progress } as ProjectTask;
        return current;
      },
      settings: async () => settings,
      docsDigest: async () => "## Style guide\nUse tabs.",
    },
    dispatch,
    bus,
    agent: { allowAllFor: (id) => allowed.push(id) },
    ownerOf: async () => ({ userId: randomUUID(), defaultProvider: "native" }),
    announce: async () => {},
    onError: () => {},
  });

  return { pipeline, sent, titles, cancelled, allowed, now: () => current };
}

describe("TaskPipeline", () => {
  it("carries a card from Research through to Done", async () => {
    const task = card();
    const h = harness(task, (text) =>
      text.includes("research step")
        ? "Brief: edit header.tsx"
        : text.includes("verification step")
          ? 'Looks right.\n{"passed": true, "reason": "Toggle present and tests pass."}'
          : "Done: added the toggle.",
    );
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();

    const end = h.now();
    expect(end.stage).toBe("done");
    expect(end.status).toBe("idle");
    // Only the reply after the last tool call is kept.
    expect(end.research).toBe("Brief: edit header.tsx");
    expect(end.verification).toMatchObject({ passed: true, reason: "Toggle present and tests pass." });
    expect(end.attempts).toBe(1);
    expect(h.titles).toEqual([`Task: ${task.title}`, `Verify: ${task.title}`]);
    // Research and the work share a thread; the verifier gets its own.
    expect(h.sent[0]!.threadId).toBe(h.sent[1]!.threadId);
    expect(h.sent[2]!.threadId).not.toBe(h.sent[1]!.threadId);
    expect(h.sent.every((s) => s.provider === "claude")).toBe(true);
    // A CLI is not sent in research mode.
    expect(h.sent[0]!.mode).toBeUndefined();
    // The coding prompt carries the brief and the documentation.
    expect(h.sent[1]!.text).toContain("Brief: edit header.tsx");
    expect(h.sent[1]!.text).toContain("Use tabs.");
    expect(h.allowed).toHaveLength(2);
  });

  it("stops at Verification waiting for input when the verifier says no", async () => {
    const task = card();
    const h = harness(task, (text) =>
      text.includes("verification step")
        ? '{"passed": false, "reason": "The toggle does not persist."}'
        : "ok",
    );
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.now()).toMatchObject({
      stage: "verification",
      status: "needs_input",
      verification: { passed: false, reason: "The toggle does not persist." },
    });
  });

  it("marks the card failed when a turn fails", async () => {
    const task = card();
    const h = harness(task, () => new Error("no credits"));
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.now()).toMatchObject({ stage: "research", status: "failed", lastError: "no credits" });
  });

  it("marks the card failed when its turn never starts", async () => {
    const task = card();
    const h = harness(task, () => DEQUEUED);
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.now()).toMatchObject({ stage: "research", status: "failed", lastError: "the agent could not start this turn" });
  });

  it("cancels the running turn when the card is taken away", async () => {
    const task = card();
    const h = harness(task, () => null);
    h.pipeline.enqueue(PROJECT, task.id);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.pipeline.cancel(task.id);
    await h.pipeline.drain();
    expect(h.cancelled).toEqual([h.sent[0]!.threadId]);
    // Nothing written over the person's move.
    expect(h.now().status).toBe("running");
    expect(h.pipeline.holds(task.id)).toBe(false);
  });

  it("includes earlier failed rounds in the research prompt", async () => {
    const task = card({ feedback: [{ reason: "Not persisted", answer: "Use localStorage", at: "x" }] });
    const h = harness(task, (text) => (text.includes("verification step") ? '{"passed": true, "reason": "ok"}' : "ok"));
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.sent[0]!.text).toContain("Use localStorage");
  });
});

describe("parseVerdict", () => {
  it("takes the last verdict in the reply", () => {
    expect(parseVerdict('{"passed": false, "reason": "a"} then {"passed": true, "reason": "b"}')).toEqual({
      passed: true,
      reason: "b",
    });
  });

  it("fails a reply with no verdict", () => {
    expect(parseVerdict("I think it is fine").passed).toBe(false);
  });
});
