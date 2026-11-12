import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DomainEvent } from "@ucch/protocol";
import { CodexNormaliser, CodexProvider } from "../packages/providers/src/codex.js";
import { CodexSubagents } from "../packages/providers/src/codex-subagents.js";
import { FakeProcessHost, stdout } from "../packages/providers/src/testing.js";
import { toMessages } from "../apps/web/src/lib/chat-messages.js";
import { lineageOf, lineageKey, subagentHref } from "../apps/web/src/lib/subagent-lineage.js";

const ids = { projectId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222", turnId: "33333333-3333-4333-8333-333333333333" };
const child = "44444444-4444-4444-8444-444444444444";
const normaliser = () => new CodexNormaliser({ ...ids, workspace: "/tmp/project" });
const item = (n: CodexNormaliser, phase: string, value: object) => n.push(JSON.stringify({ type: `item.${phase}`, item: { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", prompt: "Inspect the cache", ...value } }));

describe("native Codex subagents", () => {
  it("creates one live chat card and details entry, with a link to its own transcript view", () => {
    const n = normaliser();
    const events = [
      ...item(n, "started", { receiver_thread_ids: [] }),
      ...item(n, "completed", { receiver_thread_ids: [child], agents_states: { [child]: { status: "running" } } }),
      ...item(n, "updated", { receiver_thread_ids: [child], agents_states: { [child]: { status: "running" } } }),
    ];
    expect(events.filter(e => e.type === "agent.subagent_started")).toHaveLength(1);
    const entries = lineageOf(toMessages(events.map(event => ({ event }))).messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.run).toMatchObject({ id: child, provider: "codex", status: "running", description: "Inspect the cache" });
    expect(subagentHref(entries[0]!, { ws: "work", projectHash: "project", parentHash: "session", kind: "project" })).toBe(`/work/p/project/session?agent=${encodeURIComponent(lineageKey(entries[0]!))}`);
  });
  it("handles wait results for multiple workers and never mistakes a completed spawn call for a completed worker", () => {
    const n = normaliser();
    const started = item(n, "completed", { status: "completed", receiver_thread_ids: [child], agents_states: { [child]: { status: "running" } } });
    expect(started.some(e => e.type === "agent.subagent_finished")).toBe(false);
    const result = item(n, "completed", { id: "wait", tool: "wait", agents_states: { [child]: { status: "completed", message: "Found the cache" }, other: { status: "errored", message: "Failed" } } });
    expect(result.filter(e => e.type === "agent.subagent_finished")).toMatchObject([{ subagentId: child, status: "completed" }, { subagentId: "other", status: "failed" }]);
    expect(item(n, "completed", { tool: "wait", agents_states: { [child]: { status: "completed", message: "Found the cache" } } }).filter(e => e.type === "agent.subagent_finished")).toEqual([]);
  });
  it("keeps child text, thinking, tools and results on the subagent page instead of the parent's prose", () => {
    const n = normaliser();
    const events = item(n, "completed", { receiver_thread_ids: [child] });
    for (const payload of [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading cache.ts" }] },
      { type: "reasoning", summary: [{ text: "Check invalidation" }] },
      { type: "function_call", call_id: "tool1", name: "exec_command", arguments: '{"cmd":"cat cache.ts"}' },
      { type: "function_call_output", call_id: "tool1", output: "export const cache = new Map()" },
    ]) events.push(...n.subagents.rollout(child, JSON.stringify({ type: "response_item", payload })));
    events.push(...n.subagents.rollout(child, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done" } })));
    const messages = toMessages(events.map(event => ({ event }))).messages;
    const run = lineageOf(messages)[0]!.run;
    expect(run.steps).toHaveLength(3);
    expect(run.steps[2]).toMatchObject({ kind: "tool", result: "export const cache = new Map()" });
    expect(run.status).toBe("completed");
    expect(messages.some(m => m.text.includes("Reading cache.ts"))).toBe(false);
  });
  it("reopens a worker on follow-up and ignores transcript history from earlier runs", () => {
    const n = normaliser();
    item(n, "completed", { receiver_thread_ids: [child], agents_states: { [child]: { status: "completed", message: "Done" } } });
    const followup = item(n, "completed", { id: "followup", tool: "send_input", receiver_thread_ids: [child], agents_states: { [child]: { status: "running" } } });
    expect(followup).toContainEqual(expect.objectContaining({ type: "agent.subagent_started", subagentId: child }));
    expect(n.subagents.rollout(child, JSON.stringify({ timestamp: "2000-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "Old output" }] } }))).toEqual([]);
  });
  it("recovers legacy collaboration events without duplicating workers", () => {
    const agents = new CodexSubagents(ids);
    const raw = JSON.stringify({ type: "event_msg", payload: { type: "collab_agent_spawn_end", new_thread_id: child, prompt: "Inspect files", status: "running" } });
    expect(agents.parentRollout(raw).some(e => e.type === "agent.subagent_started")).toBe(true);
    expect(agents.parentRollout(raw).some(e => e.type === "agent.subagent_started")).toBe(false);
    expect(agents.parentRollout(JSON.stringify({ type: "event_msg", payload: { type: "collab_waiting_end", statuses: { [child]: { completed: "Done" } } } }))).toContainEqual(expect.objectContaining({ type: "agent.subagent_finished", status: "completed" }));
  });
});

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it("recovers child transcripts from disk before publishing turn completion", async () => {
  const home = await mkdtemp(join(tmpdir(), "ucch-codex-workers-"));
  dirs.push(home);
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", `rollout-${child}.jsonl`), [
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "Actual child work" }] } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Actual child work" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const host = new FakeProcessHost([{ match: () => true, lines: [
    stdout(JSON.stringify({ type: "item.completed", item: { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", prompt: "Inspect", receiver_thread_ids: [child] } })),
    stdout(JSON.stringify({ type: "turn.completed", usage: {} })),
  ] }]);
  const events: DomainEvent[] = [];
  for await (const event of new CodexProvider("codex").run({ ...ids, ctx: { cwd: home, env: { CODEX_HOME: home }, host }, prompt: "Inspect" }).events) events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.subagent_output", text: "Actual child work" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.subagent_finished", status: "completed" }));
  expect(events.at(-1)?.type).toBe("agent.turn_completed");
});

it("streams a child's work while its parent is still running, and aborts unfinished workers on interruption", async () => {
  const home = await mkdtemp(join(tmpdir(), "ucch-codex-live-"));
  dirs.push(home);
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "sessions", `rollout-${child}.jsonl`), JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "Live child progress" }] } }) + "\n");
  const host = new FakeProcessHost([{ match: () => true, waitForSignal: "SIGINT", lines: [
    stdout(JSON.stringify({ type: "item.completed", item: { id: "spawn", type: "collab_tool_call", tool: "spawn_agent", prompt: "Inspect", receiver_thread_ids: [child] } })),
  ] }]);
  const run = new CodexProvider("codex").run({ ...ids, ctx: { cwd: home, env: { CODEX_HOME: home }, host }, prompt: "Inspect" });
  const events: DomainEvent[] = [];
  try {
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "agent.subagent_output") {
        expect(events.some(e => e.type === "agent.turn_completed")).toBe(false);
        await run.interrupt();
      }
    }
  } finally { await run.interrupt(); }
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.subagent_output", text: "Live child progress" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.subagent_finished", status: "aborted" }));
});

it("does not duplicate a spawn card when rollout recovery wins the race with native completion", () => {
  const n = normaliser();
  const events = item(n, "started", {});
  events.push(...n.subagents.parentRollout(JSON.stringify({ type: "event_msg", payload: { type: "collab_agent_spawn_end", new_thread_id: child, prompt: "Inspect the cache", status: "running" } })));
  events.push(...item(n, "completed", { receiver_thread_ids: [child] }));
  expect(lineageOf(toMessages(events.map(event => ({ event }))).messages)).toHaveLength(1);
});
