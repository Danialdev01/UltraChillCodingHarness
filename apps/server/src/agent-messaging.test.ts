import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import { AgentMessaging } from "./agent-messaging.js";
import type { EventStore } from "./eventstore.js";
import type { EngineResult } from "./engine.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const ID = "55555555-5555-4555-8555-555555555555";
const source = (status = "idle", paused = false) => ({ thread: { id: THREAD, projectId: PROJECT, createdByUserId: USER, status, agentMessagesPaused: paused }, creator: USER, workspaceId: PROJECT });
const access = (status = "idle", paused = false): unknown[][] => [[source(status, paused)], [{ role: "member", canCreateProject: null, canCreateSession: null }], [{ userId: USER }]];

function setup(rows: unknown[][], history: DomainEvent[] = []) {
  const selects = vi.fn(() => {
    const result = rows.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const key of ["from", "innerJoin", "where", "orderBy", "leftJoin"]) chain[key] = () => chain;
    chain.limit = () => Promise.resolve(result);
    chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  const events: DomainEvent[] = [];
  const store = { threadHistory: async () => history.map((event) => ({ event })), append: async (_target: unknown, batch: DomainEvent[]) => { events.push(...batch); return []; } } as unknown as EventStore;
  const dispatch = vi.fn(async (_principal: unknown, command: Command): Promise<EngineResult> => ({ ok: true, events: command.type === "thread.agent_message" ? [{ event: { type: "agent.session_message", threadId: command.threadId, fromThreadId: command.fromThreadId, messageId: ID, text: command.text, depth: command.depth } }] as never : [] }));
  const errors: unknown[] = [];
  const service = new AgentMessaging({ select: selects, selectDistinct: selects } as unknown as Database, store, dispatch, (e) => errors.push(e));
  return { service, dispatch, events, errors, selects };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("AgentMessaging", () => {
  it("refuses a target outside the caller's project without dispatching", async () => {
    const { service, dispatch } = setup([...access(), []]);
    expect(await service.call(THREAD, "ucch_message", { sessionId: OTHER, text: "x" })).toEqual({ error: "session not found in this project" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("binds the sender to its session and records a sender mirror", async () => {
    const { service, dispatch, events } = setup([...access(), [{ id: OTHER, hash: "abcdef123456" }]]);
    expect(await service.call(THREAD, "ucch_message", { sessionId: OTHER, text: "Review", fromThreadId: OTHER })).toMatchObject({ text: expect.stringContaining(ID) });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, internal: true }), { type: "thread.agent_message", fromThreadId: THREAD, threadId: OTHER, text: "Review", depth: 0 });
    expect(events[0]).toMatchObject({ type: "agent.session_message_sent", toThreadId: OTHER });
  });
  it("requires a reply to be from the addressed session", async () => {
    const { service, dispatch } = setup([...access(), [{ id: OTHER }], []]);
    expect(await service.call(THREAD, "ucch_message", { sessionId: OTHER, text: "x", replyTo: ID })).toMatchObject({ error: expect.stringContaining("incoming message") });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("carries the hop budget even when the model omits replyTo", async () => {
    const { service, dispatch } = setup([...access(), [{ id: OTHER }], [{ depth: 7 }]], [{ type: "user.message", threadId: THREAD, text: "agent messages", agentMessageIds: [ID] }]);
    await service.call(THREAD, "ucch_message", { sessionId: OTHER, text: "Another question" });
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ depth: 8 });
  });
  it.each(["running", "queued", "cancelling"])("leaves messages queued while a recipient is %s", async (status) => {
    const { service, dispatch } = setup(access(status));
    service.requestDelivery(THREAD);
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("batches messages into one idle turn with durable IDs and the recipient model", async () => {
    const messages = [{ id: ID, fromThreadId: OTHER, text: "Result", depth: 0 }, { id: OTHER, fromThreadId: OTHER, text: "More", depth: 1 }];
    const { service, dispatch, events, errors } = setup([...access(), messages, [{ model: "gpt-6-sol" }]]);
    service.requestDelivery(THREAD);
    await tick();
    expect(errors).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ type: "thread.send", threadId: THREAD, model: "gpt-6-sol", agentMessageIds: [ID, OTHER] });
    expect(events).toContainEqual({ type: "agent.message_delivered", threadId: OTHER, messageIds: [ID, OTHER] });
  });
  it("does not wake a stopped session or consume a slot while managed", async () => {
    const { service, dispatch, selects } = setup(access("idle", true));
    service.manage(THREAD);
    service.requestDelivery(THREAD);
    await tick();
    expect(selects).not.toHaveBeenCalled();
    service.release(THREAD);
    await tick();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not acknowledge messages when the engine rejects their turn", async () => {
    const { service, dispatch, events } = setup([...access(), [{ id: ID, fromThreadId: OTHER, text: "x", depth: 0 }], []]);
    dispatch.mockResolvedValue({ ok: false, code: "conflict", message: "busy" });
    service.requestDelivery(THREAD);
    await tick();
    expect(events).toEqual([]);
  });
});


it("recovers interrupted child ownership without restarting its task", async () => {
  const { service, dispatch, events } = setup([[{ id: "run", parentThreadId: THREAD, childThreadId: OTHER, background: false }], [{ id: THREAD, projectId: PROJECT }], []]);
  await service.recover();
  expect(dispatch).not.toHaveBeenCalled();
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "turn.dequeued", threadId: OTHER, reason: "error" }),
    expect.objectContaining({ type: "agent.subagent_finished", subagentId: "run", status: "failed", result: expect.stringContaining("not automatically restarted") }),
  ]));
});
