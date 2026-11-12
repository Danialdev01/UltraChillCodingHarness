import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DomainEvent, isTransient, type DomainEvent as Event } from "../packages/protocol/src/index.js";
import { CodexSubagents } from "../packages/providers/src/codex-subagents.js";
import { CodexProvider } from "../packages/providers/src/codex.js";
import { FakeProcessHost, stdout } from "../packages/providers/src/testing.js";
import { toMessages } from "../apps/web/src/lib/chat-messages.js";
import { lineageOf } from "../apps/web/src/lib/subagent-lineage.js";

const ids = { projectId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222", turnId: "33333333-3333-4333-8333-333333333333" };
const parentId = "10000000-0000-4000-8000-000000000001";
const fixture = (name: string): any[] => readFileSync(new URL(`./fixtures/codex-0.167.0/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
const rows = fixture("parent");
const feed = (agents: CodexSubagents, records: any[]) => records.flatMap(row => agents.parentRollout(JSON.stringify(row)));
const runs = (events: Event[]) => lineageOf(toMessages(events.map(event => ({ event }))).messages).map(entry => entry.run);
const record = (payload: object, ordinal: number) => ({ type: "response_item", ordinal, payload });
const turnEnd: Event = { type: "agent.turn_completed", ...ids, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 };

describe("captured Codex 0.167 native v2", () => {
  it("shows two concurrent named workers before the parent finishes; spawn/wait success leaves both running", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 34));
    expect(runs(events)).toMatchObject([{ agent: "alpha", status: "running", provider: "codex", model: null, description: null }, { agent: "beta", status: "running" }]);
    expect(events.filter(e => e.type === "agent.subagent_started")).toHaveLength(2);
    expect(events.some(e => e.type === "agent.subagent_finished" || e.type === "agent.turn_completed")).toBe(false);
    expect(events.filter(e => e.type === "agent.tool_result")).toHaveLength(2);
  });

  it("correlates final replies and followup, clears stale results, and reconstructs from durable replay", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 49));
    expect(runs(events)).toMatchObject([{ agent: "alpha", status: "running", result: null, durationMs: null }, { agent: "beta", status: "completed", result: "BETA_OK" }]);
    events.push(...feed(agents, rows.filter(row => row.ordinal >= 49)), turnEnd);
    expect(runs(events)).toMatchObject([{ agent: "alpha", status: "completed", result: "ALPHA_AGAIN" }, { agent: "beta", status: "completed", result: "BETA_OK" }]);
    expect(feed(agents, rows)).toEqual([]);
    expect(runs(events.filter(e => !isTransient(e.type)))).toEqual(runs(events).map(run => ({ ...run, summary: null })));
    for (const event of events) expect(DomainEvent.safeParse(event).success).toBe(true);
  });

  it("uses captured list_agents interruption and resumed completion without creating extra cards", () => {
    const agents = new CodexSubagents(ids);
    const records = fixture("interruption");
    const followup = records.findIndex(row => row.payload.name === "followup_task");
    const events = feed(agents, records.slice(0, followup));
    expect(runs(events)).toMatchObject([{ agent: "lifecycle", status: "aborted" }]);
    events.push(...feed(agents, records.slice(followup)));
    expect(runs(events)).toMatchObject([{ agent: "lifecycle", status: "completed", result: "RESUMED" }]);
    expect(runs(events)).toHaveLength(1);
  });

  it("filters inherited parent messages and synthetic aborts, routes real child work, and deduplicates record replay", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 34));
    const id = runs(events)[0]!.id;
    const worker = fixture("alpha").filter(row => row.ordinal < 30);
    for (const row of worker) events.push(...agents.rollout(id, JSON.stringify(row)));
    expect(runs(events)[0]).toMatchObject({ status: "completed", result: "ALPHA_OK", durationMs: 3498 });
    const output = events.filter(e => e.type === "agent.subagent_output").map(e => e.text).join("\n");
    expect(output).toBe("ALPHA_OK");
    expect(events.some(e => e.type === "agent.subagent_finished" && e.status === "aborted")).toBe(false);
    expect(worker.flatMap(row => agents.rollout(id, JSON.stringify(row)))).toEqual([]);
    expect(agents.sessions.get(id)).toBe("10000000-0000-4000-8000-000000000002");
    expect(agents.bindSession({ ...worker[0].payload, parent_thread_id: "other", source: {} })).toBeUndefined();
  });

  it("routes child tools and progress to details and ignores a terminal record from the previous task", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 34));
    const id = runs(events)[0]!.id;
    const worker = fixture("alpha");
    for (const row of worker.filter(row => row.ordinal <= 18)) events.push(...agents.rollout(id, JSON.stringify(row)));
    const toolAt = "2026-11-10T08:17:17.000Z";
    for (const payload of [
      { type: "function_call", name: "exec_command", call_id: "inspect", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "inspect", output: "/tmp" },
    ]) events.push(...agents.rollout(id, JSON.stringify({ type: "response_item", timestamp: toolAt, payload })));
    expect(runs(events)[0]!.steps).toContainEqual(expect.objectContaining({ kind: "tool", name: "exec_command", result: "/tmp" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.subagent_progress", subagentId: id, summary: "exec_command" }));
    expect(toMessages(events.map(event => ({ event }))).messages.flatMap(message => message.parts).filter(part => part.kind === "tool")).toHaveLength(2);
    events.push(...feed(agents, rows.filter(row => row.ordinal >= 34 && row.ordinal < 49)));
    events.push(...agents.rollout(id, JSON.stringify({ ...worker.find(row => row.payload.type === "task_complete"), ordinal: 999 })));
    expect(runs(events)[0]).toMatchObject({ status: "running", result: null, durationMs: null });
  });

  it("normalizes a failure status using the captured status envelope and ignores unknown/malformed records", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 34));
    // Deliberate error variant of the captured list_agents result, not a claimed live failure capture.
    events.push(...feed(agents, [record({ type: "function_call", namespace: "collaboration", name: "list_agents", call_id: "status", arguments: "{}" }, 900),
      record({ type: "function_call_output", call_id: "status", output: JSON.stringify({ agents: [{ agent_name: "/root/alpha", agent_status: { errored: "Worker failed" } }] }) }, 901)]));
    expect(runs(events)[0]).toMatchObject({ status: "failed", result: "Worker failed" });
    expect(agents.parentRollout("null")).toEqual([]);
    expect(agents.parentRollout('{"type":"new_future_item"}')).toEqual([]);
    expect(agents.parentRollout("broken")).toEqual([]);
  });

  it("keeps native and MCP-created children distinct and lets independent child sessions outlive the parent", () => {
    const agents = new CodexSubagents(ids);
    const events = feed(agents, rows.filter(row => row.ordinal < 34));
    const bridgeStart: Event = { type: "agent.subagent_started", ...ids, subagentId: "mcp-child", parentToolUseId: "bridge-call", provider: "codex", agent: "bridge", model: null, description: "Bridge task", childThreadId: "44444444-4444-4444-8444-444444444444", background: true };
    events.push(bridgeStart, turnEnd);
    expect(runs(events)).toMatchObject([{ agent: "alpha", status: "aborted" }, { agent: "beta", status: "aborted" }, { agent: "bridge", status: "running" }]);
  });
});

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it("streams captured rollout starts before exec finishes, discovers only this parent's files, and settles unknown outcomes on cancellation", async () => {
  const home = await mkdtemp(join(tmpdir(), "ucch-codex-v2-")); dirs.push(home);
  const sessions = join(home, "sessions"); await mkdir(sessions);
  await writeFile(join(sessions, `rollout-${parentId}.jsonl`), rows.filter(row => row.ordinal < 34).map(row => JSON.stringify(row)).join("\n") + "\n");
  // Includes genuine child metadata and inherited transcript; no actual child completion yet.
  for (const name of ["alpha", "beta"]) {
    const child = fixture(name).filter(row => row.payload.type !== "task_complete" && row.timestamp < "2026-11-10T08:17:19.000Z");
    await writeFile(join(sessions, `rollout-${child[0].payload.id}.jsonl`), child.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  const host = new FakeProcessHost([{ match: () => true, waitForSignal: "SIGINT", lines: [stdout(JSON.stringify({ type: "thread.started", thread_id: parentId }))] }]);
  const run = new CodexProvider("codex").run({ ...ids, ctx: { cwd: home, env: { CODEX_HOME: home }, host }, prompt: "probe" });
  const events: Event[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (events.filter(e => e.type === "agent.subagent_started").length === 2 && event.type === "agent.subagent_started") {
      expect(events.some(e => e.type === "agent.turn_completed")).toBe(false);
      await run.interrupt();
    }
  }
  expect(runs(events)).toMatchObject([{ agent: "alpha", status: "aborted", result: expect.stringContaining("outcome") }, { agent: "beta", status: "aborted" }]);
  expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed", stopReason: "cancelled" });
});

it("restores native identity across parent executions without restarting historical siblings", () => {
  const previous = new CodexSubagents(ids);
  const original = feed(previous, rows);
  const agents = new CodexSubagents({ ...ids, now: () => Date.parse("2026-11-10T08:18:00Z") });
  feed(agents, rows);
  agents.restored();
  const followupRows = rows.filter(row => [43, 46, 55].includes(row.ordinal)).map(row => ({
    ...row, timestamp: "2026-11-10T08:18:01Z", ordinal: row.ordinal + 100,
  }));
  const next = feed(agents, followupRows);
  expect(next.filter(e => e.type === "agent.subagent_started")).toHaveLength(1);
  expect(next.filter(e => e.type === "agent.subagent_started")[0]).toMatchObject({ subagentId: runs(original)[0]!.id });
  expect(runs([...original, ...next])).toMatchObject([{ agent: "alpha", status: "completed", result: "ALPHA_AGAIN" }, { agent: "beta", status: "completed", result: "BETA_OK" }]);
  expect([...agents.children.keys()].flatMap(id => agents.finish(id, "aborted", "observer ended"))).toEqual([]);
});

it("enriches a parent's final reply with the worker's own duration after draining its rollout", () => {
  const agents = new CodexSubagents(ids);
  const events = feed(agents, rows);
  const id = runs(events)[0]!.id;
  for (const row of fixture("alpha")) events.push(...agents.rollout(id, JSON.stringify(row)));
  expect(runs(events)[0]).toMatchObject({ status: "completed", result: "ALPHA_AGAIN", durationMs: 2044, toolCalls: 0 });
  expect(events.filter(e => e.type === "agent.subagent_started")).toHaveLength(3);
});

it("does not mistake an MCP tool named spawn_agent for a native collaboration spawn", () => {
  const agents = new CodexSubagents(ids);
  expect(feed(agents, [record({ type: "function_call", namespace: "mcp_bridge", name: "spawn_agent", call_id: "mcp", arguments: '{"task_name":"bridge"}' }, 1000),
    record({ type: "function_call_output", call_id: "mcp", output: '{"task_name":"/root/bridge"}' }, 1001)])).toEqual([]);
  expect(agents.children.size).toBe(0);
});

it("settles unobserved workers honestly on normal parent completion or provider failure and disposes mappings", async () => {
  const { withCodexSubagents } = await import("../packages/providers/src/codex-subagents.js");
  for (const terminal of [turnEnd, { type: "agent.turn_failed", ...ids, error: "Parent provider failed" } as Event]) {
    const agents = new CodexSubagents(ids);
    const starts = feed(agents, rows.filter(row => row.ordinal < 34));
    const source = { interrupt: async () => {}, events: { async *[Symbol.asyncIterator]() { yield* starts; yield terminal; } } };
    const run = withCodexSubagents({ ...ids, prompt: "probe", ctx: { cwd: "/tmp", env: {}, host: new FakeProcessHost([]) } }, source, agents);
    const events: Event[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.filter(e => e.type === "agent.subagent_finished")).toMatchObject([{ status: "aborted", result: expect.stringContaining("outcome") }, { status: "aborted" }]);
    expect(events.at(-1)).toEqual(terminal);
    expect(agents.children.size).toBe(0);
    expect(agents.sessions.size).toBe(0);
  }
});

it("settles child observation and cleans up if the upstream event iterator throws", async () => {
  const { withCodexSubagents } = await import("../packages/providers/src/codex-subagents.js");
  const agents = new CodexSubagents(ids);
  const starts = feed(agents, rows.filter(row => row.ordinal < 34));
  const source = { interrupt: async () => {}, events: { async *[Symbol.asyncIterator](): AsyncGenerator<Event> { yield* starts; throw new Error("stream lost"); } } };
  const run = withCodexSubagents({ ...ids, prompt: "probe", ctx: { cwd: "/tmp", env: {}, host: new FakeProcessHost([]) } }, source, agents);
  const events: Event[] = [];
  await expect((async () => { for await (const event of run.events) events.push(event); })()).rejects.toThrow("stream lost");
  expect(events.filter(e => e.type === "agent.subagent_finished")).toMatchObject([{ status: "aborted" }, { status: "aborted" }]);
  expect(agents.children.size).toBe(0);
});

it("does not starve rollout polling while exec continuously streams other activity", async () => {
  const { ManualProcessHost } = await import("../packages/providers/src/testing.js");
  const home = await mkdtemp(join(tmpdir(), "ucch-codex-busy-")); dirs.push(home);
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", `rollout-${parentId}.jsonl`), rows.filter(row => row.ordinal < 34).map(row => JSON.stringify(row)).join("\n") + "\n");
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expired = false;
  let sequence = 0;
  const host = new ManualProcessHost(child => {
    child.emit(JSON.stringify({ type: "thread.started", thread_id: parentId }));
    heartbeat = setInterval(() => child.emit(JSON.stringify({ type: "item.completed", item: { type: "reasoning", id: `heartbeat-${sequence++}`, text: "Parent is working" } })), 10);
    child.onSignal = () => { clearInterval(heartbeat); child.exit(); };
  });
  const run = new CodexProvider("codex").run({ ...ids, ctx: { cwd: home, env: { CODEX_HOME: home }, host }, prompt: "probe" });
  const timeout = setTimeout(() => { expired = true; void run.interrupt(); }, 1500);
  let visibleWhileBusy = false;
  try {
    for await (const event of run.events) if (event.type === "agent.subagent_started") {
      visibleWhileBusy ||= !expired;
      await run.interrupt();
    }
  } finally { clearTimeout(timeout); clearInterval(heartbeat); await run.interrupt(); }
  expect(visibleWhileBusy).toBe(true);
});

it("retains the observed worker model across durable replay", () => {
  const agents = new CodexSubagents(ids);
  const events = feed(agents, rows.filter(row => row.ordinal < 34));
  const id = runs(events)[0]!.id;
  for (const row of fixture("alpha").filter(row => row.ordinal < 30)) events.push(...agents.rollout(id, JSON.stringify(row)));
  expect(runs(events)[0]).toMatchObject({ model: "gpt-6.1-sol", status: "completed" });
  expect(runs(events.filter(event => !isTransient(event.type)))[0]).toMatchObject({ model: "gpt-6.1-sol", status: "completed" });
});

it("shows a supplied plaintext task brief without exposing encrypted messages", () => {
  const agents = new CodexSubagents(ids);
  const records = rows.filter(row => row.ordinal <= 18).map(row => row.payload.name === "spawn_agent" ? {
    ...row, payload: { ...row.payload, arguments: JSON.stringify({ task_name: "alpha", message: "Inspect the cache" }) },
  } : row);
  const events = feed(agents, records);
  expect(runs(events)[0]).toMatchObject({ description: "Inspect the cache" });
  const encrypted = new CodexSubagents(ids);
  const encryptedEvents = feed(encrypted, records.map(row => row.payload.name === "spawn_agent" ? {
    ...row, payload: { ...row.payload, arguments: JSON.stringify({ task_name: "alpha", message: "gAAAAencrypted" }) },
  } : row));
  expect(runs(encryptedEvents)[0]).toMatchObject({ description: null });
});
