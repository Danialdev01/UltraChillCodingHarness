import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { EventBus, type Publication } from "./bus.js";
import { activityOf, ProjectActivityPublisher } from "./project-activity.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "66666666-6666-6666-6666-666666666666";
const WORKSPACE = "55555555-5555-5555-5555-555555555555";

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const completed = (stopReason: string | null): DomainEvent => ({
  type: "agent.turn_completed",
  threadId: THREAD,
  turnId: TURN,
  stopReason,
  usage,
  costUsd: 0,
});
const started: DomainEvent = { type: "turn.started", threadId: THREAD, turnId: TURN };

describe("activityOf", () => {
  it("reads each turn edge", () => {
    expect(activityOf({ type: "user.message", threadId: THREAD, text: "hi" })?.state).toBe("queued");
    expect(activityOf(started)?.state).toBe("running");
    expect(activityOf(completed("end_turn"))?.state).toBe("done");
    expect(activityOf(completed(null))?.state).toBe("done");
    expect(activityOf(completed("max_tokens"))?.state).toBe("failed");
    expect(activityOf(completed("error_max_turns"))?.state).toBe("failed");
    expect(activityOf(completed("cancelled"))?.state).toBe("idle");
    expect(activityOf({ type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "x" })?.state).toBe("failed");
    expect(activityOf({ type: "turn.dequeued", threadId: THREAD, reason: "restart" })).toEqual({
      threadId: THREAD,
      state: "idle",
    });
  });

  it("is null for everything else", () => {
    expect(activityOf({ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "x" })).toBeNull();
    expect(activityOf({ type: "file.changed", projectId: PROJECT, path: "a", change: "modified" })).toBeNull();
  });
});

function setup(workspaceOf: (projectId: string) => Promise<string | null>) {
  const bus = new EventBus();
  const heard: { topic: string; event: DomainEvent }[] = [];
  bus.subscribe({ name: "workspace", workspaceId: WORKSPACE }, ({ event }) => heard.push({ topic: "workspace", event }));
  bus.subscribe({ name: "project", projectId: PROJECT }, ({ event }) => heard.push({ topic: "project", event }));
  const errors: unknown[] = [];
  const stop = new ProjectActivityPublisher(bus, workspaceOf, (error) => errors.push(error)).start();
  const publish = (event: DomainEvent) => {
    const publication: Publication = { seq: null, projectId: PROJECT, threadId: THREAD, event };
    bus.publish(publication);
  };
  return { bus, heard, errors, stop, publish };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ProjectActivityPublisher", () => {
  it("tells the project's workspace, in order, looking the workspace up once", async () => {
    let lookups = 0;
    const { heard, publish } = setup(async () => {
      lookups++;
      await new Promise((r) => setTimeout(r, 5));
      return WORKSPACE;
    });
    publish(started);
    publish(completed("end_turn"));
    await new Promise((r) => setTimeout(r, 20));
    publish(started);
    await flush();

    const activity = heard.filter((h) => h.event.type === "project.activity");
    expect(activity.map((h) => h.topic)).toEqual(["workspace", "workspace", "workspace"]);
    expect(activity.map((h) => (h.event as { state: string }).state)).toEqual(["running", "done", "running"]);
    expect(activity[0]!.event).toEqual({ type: "project.activity", projectId: PROJECT, threadId: THREAD, state: "running" });
    expect(lookups).toBe(1);
  });

  it("says a new stack is a change to the workspace's project list", async () => {
    const { heard, publish } = setup(async () => WORKSPACE);
    publish({ type: "project.stack_detected", projectId: PROJECT, stack: "node" });
    await flush();
    expect(heard.filter((h) => h.topic === "workspace").map((h) => h.event)).toEqual([
      { type: "resource.changed", projectId: PROJECT, resource: "projects" },
    ]);
  });

  it("stays quiet for other events, and asks again after a miss", async () => {
    const answers: Array<string | null | Error> = [new Error("db down"), null, WORKSPACE];
    let lookups = 0;
    const { heard, errors, publish } = setup(async () => {
      lookups++;
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    publish({ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "x" });
    await flush();
    expect(lookups).toBe(0);

    for (let i = 0; i < 3; i++) {
      publish(started);
      await flush();
    }
    expect(lookups).toBe(3);
    expect(errors).toHaveLength(1);
    expect(heard.filter((h) => h.topic === "workspace")).toHaveLength(1);
  });

  it("stops listening when told", async () => {
    const { heard, publish, stop } = setup(async () => WORKSPACE);
    stop();
    publish(started);
    await flush();
    expect(heard.filter((h) => h.topic === "workspace")).toEqual([]);
  });
});
