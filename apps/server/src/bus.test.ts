import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { EventBus, type Publication } from "./bus.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const TERMINAL = "77777777-7777-7777-7777-777777777777";

function heard(bus: EventBus, topic: Parameters<EventBus["subscribe"]>[0]): Publication[] {
  const got: Publication[] = [];
  bus.subscribe(topic, (p) => got.push(p));
  return got;
}

describe("EventBus", () => {
  it("sends terminal output to the terminal's topic only, never the project's", () => {
    const bus = new EventBus();
    const project = heard(bus, { name: "project", projectId: PROJECT });
    const terminal = heard(bus, { name: "terminal", terminalId: TERMINAL });
    const event = { type: "terminal.output", projectId: PROJECT, terminalId: TERMINAL, data: "secret" } as DomainEvent;
    bus.publish({ seq: null, projectId: PROJECT, threadId: null, event });
    expect(terminal).toHaveLength(1);
    expect(project).toHaveLength(0);
  });

  it("sends thread events to the thread and its project", () => {
    const bus = new EventBus();
    const project = heard(bus, { name: "project", projectId: PROJECT });
    const thread = heard(bus, { name: "thread", threadId: "t1" });
    const event = { type: "note.changed", projectId: PROJECT } as unknown as DomainEvent;
    bus.publish({ seq: 1, projectId: PROJECT, threadId: "t1", event });
    expect(project).toHaveLength(1);
    expect(thread).toHaveLength(1);
  });

  it("sends a turn's tokens to its thread only, and the rest of the turn to both", () => {
    const bus = new EventBus();
    const project = heard(bus, { name: "project", projectId: PROJECT });
    const thread = heard(bus, { name: "thread", threadId: "t1" });
    const tap: Publication[] = [];
    bus.tap((p) => tap.push(p));
    for (const type of ["agent.text_delta", "agent.thinking_delta"] as const) {
      const event = { type, threadId: "t1", turnId: "u1", text: "x" } as DomainEvent;
      bus.publish({ seq: null, projectId: PROJECT, threadId: "t1", event });
    }
    expect(thread).toHaveLength(2);
    expect(project).toHaveLength(0);
    expect(tap).toHaveLength(2);
    const ended = { type: "agent.message", threadId: "t1", turnId: "u1", text: "x" } as unknown as DomainEvent;
    bus.publish({ seq: 2, projectId: PROJECT, threadId: "t1", event: ended });
    expect(thread).toHaveLength(3);
    expect(project).toHaveLength(1);
  });
});
