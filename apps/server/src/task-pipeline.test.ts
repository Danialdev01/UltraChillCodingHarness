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
import { TaskPipeline, ompVerdict, parseVerdict, verifyBrief } from "./task-pipeline.js";
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

interface HarnessOptions {
  /** The task's own agent (Settings → Tasks). */
  provider?: TaskSettings["provider"];
  /** The workspace's "Verify with OMP". */
  omp?: boolean;
  /** What an OMP turn's `task` worker answers, as `agent.subagent_finished`. */
  worker?: (text: string) => string | null;
}

function harness(
  task: ProjectTask,
  replies: (text: string) => string | Error | null | typeof DEQUEUED,
  options: HarnessOptions = {},
) {
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
        const worker = command.provider === "omp" ? options.worker?.(command.text) : null;
        if (worker) {
          emit(threadId, {
            type: "agent.subagent_finished",
            threadId,
            turnId,
            subagentId: "VerifyTask",
            status: "completed",
            result: worker,
          } as unknown as DomainEvent);
        }
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

  const settings: TaskSettings = {
    provider: options.provider ?? "claude",
    model: options.provider === "codex" ? "gpt-5-codex" : null,
    autoRun: DEFAULT_TASK_AUTO_RUN,
  };
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
    verifiesWithOmp: async () => options.omp ?? false,
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

describe("Verify with OMP (OM7.9)", () => {
  const UNMET = {
    passed: false,
    reason: "The toggle is not persisted across reloads.",
    findings: [{ file: "src/header.tsx", line: 42, note: "The toggle state lives in useState only; nothing writes localStorage." }],
  };
  const block = (verdict: unknown) => "```json\n" + JSON.stringify(verdict) + "\n```";

  it.each(["claude", "codex"] as const)(
    "fails a task with an unmet criterion, with findings, after a %s coding step",
    async (provider) => {
      const task = card({ description: "In the header.\n\nAcceptance: the choice survives a reload." });
      const h = harness(
        task,
        (text) =>
          text.includes("Task verification request")
            ? `The verifier says it is not done.\n\n${block(UNMET)}`
            : text.includes("research step")
              ? "Brief: edit header.tsx"
              : "Done: added the toggle.",
        { provider, omp: true },
      );
      h.pipeline.enqueue(PROJECT, task.id);
      await h.pipeline.drain();

      expect(h.now()).toMatchObject({
        stage: "verification",
        status: "needs_input",
        verification: { ...UNMET, threadId: h.sent[2]!.threadId },
      });
      // The work on the task's agent, the verification on OMP -- with no
      // model, so OMP takes the account's OpenRouter one, not the CLI's.
      expect(h.sent.map((s) => s.provider)).toEqual([provider, provider, "omp"]);
      expect(h.sent[2]!.model).toBeUndefined();
      expect(h.sent[2]!.mode).toBeUndefined();
      // The bundled `task` agent, the role in `context`, the card as its assignment.
      const prompt = h.sent[2]!.text;
      expect(prompt).toContain('agent: "task"');
      expect(prompt).toContain("Cite file and line for every finding. Do not edit files.");
      expect(prompt).toContain("Acceptance: the choice survives a reload.");
      expect(prompt).toContain("## What the coding agent reported\nDone: added the toggle.");
      expect(prompt).toContain('"findings"');
    },
  );

  it("reads the worker's verdict when the main agent did not repeat it", async () => {
    const task = card();
    const h = harness(task, (text) => (text.includes("Task verification request") ? "The worker has reported." : "ok"), {
      omp: true,
      worker: () => `Checked header.tsx.\n\n${block(UNMET)}`,
    });
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.now()).toMatchObject({ status: "needs_input", verification: UNMET });
  });

  it("passes a task OMP passes, and keeps parseVerdict as the fallback", async () => {
    const passed = card();
    const h = harness(passed, (text) =>
      text.includes("Task verification request") ? block({ passed: true, reason: "Persisted and tested.", findings: [] }) : "ok",
    { omp: true });
    h.pipeline.enqueue(PROJECT, passed.id);
    await h.pipeline.drain();
    expect(h.now()).toMatchObject({ stage: "done", status: "idle", verification: { passed: true, reason: "Persisted and tested." } });
    expect(h.now().verification).not.toHaveProperty("findings");

    const loose = card();
    const l = harness(loose, (text) =>
      text.includes("Task verification request") ? 'All good: {"passed": true, "reason": "fine"}' : "ok",
    { omp: true });
    l.pipeline.enqueue(PROJECT, loose.id);
    await l.pipeline.drain();
    expect(l.now()).toMatchObject({ stage: "done", verification: { passed: true, reason: "fine" } });
  });

  it("leaves verification to the task's agent while the setting is off", async () => {
    const task = card();
    const h = harness(task, (text) => (text.includes("verification step") ? '{"passed": true, "reason": "ok"}' : "ok"), {
      provider: "codex",
    });
    h.pipeline.enqueue(PROJECT, task.id);
    await h.pipeline.drain();
    expect(h.sent.map((s) => s.provider)).toEqual(["codex", "codex", "codex"]);
    expect(h.sent[2]!.text).not.toContain("Task verification request");
    expect(h.now().stage).toBe("done");
  });
});

describe("ompVerdict", () => {
  it("prefers the reply's block, then the last worker's, then the regex", () => {
    const fenced = (passed: boolean, reason: string) => "```json\n" + JSON.stringify({ passed, reason, findings: [] }) + "\n```";
    expect(ompVerdict(fenced(true, "reply"), [fenced(false, "worker")])).toEqual({ passed: true, reason: "reply" });
    expect(ompVerdict("no block", [fenced(true, "first"), fenced(false, "last")])).toEqual({ passed: false, reason: "last" });
    expect(ompVerdict('{"passed": true, "reason": "regex"}', ["nothing here"])).toEqual({ passed: true, reason: "regex" });
    expect(ompVerdict("silence", []).passed).toBe(false);
  });

  it("brief is the card without the coding verifier's own instructions", () => {
    const brief = verifyBrief(card({ research: "Use localStorage." }), "Added it.");
    expect(brief).toContain("## Research brief\nUse localStorage.");
    expect(brief).toContain("## What the coding agent reported\nAdded it.");
    expect(brief).not.toContain("verification step");
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
