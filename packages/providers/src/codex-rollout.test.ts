import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { lastCallUsage, readCodexRollout, turnUsage } from "./codex-rollout.js";
import { CodexProvider, compactCodexThread, mapCodexUsage, withCodexContext } from "./codex.js";
import { FakeProcessHost, stdout } from "./testing.js";
import type { AgentRun, ProviderRunInput } from "./types.js";

/** Two `exec` turns, a `/compact` sent as a message, and an app-server compaction, from codex-cli 0.170.0. */
const FIXTURE = join(import.meta.dirname, "fixtures", "codex-rollout.jsonl");
const SESSION = "01a1fdaa-7d7c-7250-8b7c-2032f9bfff27";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

/** The fixture's lines up to (not including) the one with this ordinal, and the byte offset there. */
async function upTo(ordinal: number): Promise<{ text: string; offset: number }> {
  const lines = (await readFile(FIXTURE, "utf8")).trimEnd().split("\n");
  const kept = lines.filter((line) => (JSON.parse(line) as { ordinal: number }).ordinal < ordinal);
  const text = kept.map((line) => `${line}\n`).join("");
  return { text, offset: Buffer.byteLength(text) };
}

describe("the Codex rollout (codex-cli 0.170.0)", () => {
  it("reads the last call, not the thread's running total", async () => {
    const { reading, before } = await readCodexRollout(FIXTURE);
    // After the app-server compaction: the folded size alone.
    expect(reading.last).toEqual({ input: 0, cached: 0, output: 0, total: 18130 });
    expect(reading.windowTokens).toBe(475_000);
    expect(before).toBeNull();
    expect(reading.compactions).toEqual([{ tokensAfter: 18130 }]);
  });

  it("splits a turn from the ones before it by byte offset", async () => {
    // From the second turn's task_started (ordinal 19) to the third's (29).
    const { text } = await upTo(29);
    const { offset } = await upTo(19);
    const base = await mkdtemp(join(tmpdir(), "ucch-rollout-"));
    cleanups.push(base);
    const path = join(base, "rollout.jsonl");
    await writeFile(path, text);
    const { reading, before } = await readCodexRollout(path, offset);
    expect(before).toEqual({ input: 15549, cached: 12160, output: 5, total: 15554 });
    expect(reading.last).toEqual({ input: 15567, cached: 15360, output: 5, total: 15572 });
    expect(reading.total).toEqual({ input: 31116, cached: 27520, output: 10, total: 31126 });
    // The turn's own share of the running total, which is what stdout reported for it.
    expect(turnUsage(reading.total!, before)).toEqual({ inputTokens: 207, outputTokens: 5, cacheReadInputTokens: 15360, cacheCreationInputTokens: 0 });
    expect(lastCallUsage(reading.last!)).toEqual({ inputTokens: 207, outputTokens: 5, cacheReadInputTokens: 15360, cacheCreationInputTokens: 0 });
    expect(reading.compactions).toEqual([]);
  });

  it("maps stdout's usage with the cached part taken out of the input", () => {
    // `turn.completed` of the fixture's second turn: the thread's total.
    expect(mapCodexUsage({ input_tokens: 31116, cached_input_tokens: 27520, cache_write_input_tokens: 0, output_tokens: 10 })).toEqual({
      inputTokens: 3596,
      outputTokens: 10,
      cacheReadInputTokens: 27520,
      cacheCreationInputTokens: 0,
    });
  });
});

describe("withCodexContext", () => {
  const ids = { projectId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222", turnId: "33333333-3333-4333-8333-333333333333" };

  async function home(text: string) {
    const base = await mkdtemp(join(tmpdir(), "ucch-codex-home-"));
    cleanups.push(base);
    const dir = join(base, "sessions", "2026", "11", "21");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-21T18-32-52-${SESSION}.jsonl`);
    await writeFile(path, text);
    return { base, path };
  }

  function fakeRun(events: DomainEvent[], before?: () => Promise<void>): AgentRun {
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          await before?.();
          for (const event of events) yield event;
        },
      },
      interrupt: async () => {},
      kill: async () => {},
    } as unknown as AgentRun;
  }

  it("sends the turn's last-call reading and its own usage ahead of its end", async () => {
    const first = await upTo(19);
    const both = await upTo(29);
    const { base, path } = await home(first.text);
    const input: ProviderRunInput = { ...ids, ctx: { cwd: base, env: { CODEX_HOME: base }, host: new FakeProcessHost([]) }, prompt: "again", resumeToken: SESSION, model: "gpt-6.1-sol" };
    const completed: DomainEvent = {
      type: "agent.turn_completed",
      threadId: ids.threadId,
      turnId: ids.turnId,
      stopReason: "end_turn",
      // What stdout says: the running total, mapped.
      usage: mapCodexUsage({ input_tokens: 31116, cached_input_tokens: 27520, output_tokens: 10 }),
      costUsd: 0,
    };
    // The turn writes its lines while it runs.
    const run = withCodexContext(input, () => fakeRun([completed], () => writeFile(path, both.text)), () => SESSION, () => Date.parse("2026-11-21T10:33:01Z"));
    const events: DomainEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["context.usage", "agent.turn_completed"]);
    expect(events[0]).toEqual({
      type: "context.usage",
      threadId: ids.threadId,
      turnId: ids.turnId,
      usedTokens: 15572,
      windowTokens: 475_000,
      thresholdTokens: 427_500,
      status: "complete",
      cachedTokens: 15360,
      harness: "codex",
      model: "gpt-6.1-sol",
      at: "2026-11-21T10:33:01.000Z",
    });
    expect(events[1]).toMatchObject({ usage: { inputTokens: 207, outputTokens: 5, cacheReadInputTokens: 15360 } });
    expect((await stat(path)).size).toBe(both.offset);
  });

  it("says unavailable, never 0, without a rollout", async () => {
    const base = await mkdtemp(join(tmpdir(), "ucch-codex-home-"));
    cleanups.push(base);
    const input: ProviderRunInput = { ...ids, ctx: { cwd: base, env: { CODEX_HOME: base }, host: new FakeProcessHost([]) }, prompt: "hi" };
    const events: DomainEvent[] = [];
    for await (const event of withCodexContext(input, () => fakeRun([]), () => null).events) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ type: "context.usage", usedTokens: null, status: "unavailable", windowTokens: 272_000 }),
    ]);
  });

  it("draws a compaction Codex made mid-turn", async () => {
    const { base } = await home("");
    await copyFile(FIXTURE, join(base, "sessions", "2026", "11", "21", `rollout-2026-11-21T18-32-52-${SESSION}.jsonl`));
    const input: ProviderRunInput = { ...ids, ctx: { cwd: base, env: { CODEX_HOME: base }, host: new FakeProcessHost([]) }, prompt: "hi" };
    const events: DomainEvent[] = [];
    for await (const event of withCodexContext(input, () => fakeRun([]), () => SESSION).events) events.push(event);
    expect(events[0]).toEqual({
      type: "context.injected",
      threadId: ids.threadId,
      turnId: ids.turnId,
      source: "compaction",
      content: "",
      compaction: { method: "auto", tokensAfter: 18130 },
    });
    expect(events[1]).toMatchObject({ type: "context.usage", usedTokens: 18130 });
  });
});

describe("compacting a Codex session in place", () => {
  const line = (message: object) => stdout(JSON.stringify(message));
  const usage = (total: number) => ({ method: "thread/tokenUsage/updated", params: { threadId: SESSION, tokenUsage: { last: { totalTokens: total }, total: { totalTokens: 46713 }, modelContextWindow: 475_000 } } });

  it("resumes the thread, starts the compaction, and reads the size before and after", async () => {
    // The app server's answers to `thread/resume` and `thread/compact/start`, as 0.170.0 sends them.
    const host = new FakeProcessHost([
      {
        match: (argv) => argv[1] === "app-server",
        lines: [
          line({ id: 1, result: {} }),
          line({ id: 2, result: { thread: { id: SESSION } } }),
          line(usage(15587)),
          line({ id: 3, result: {} }),
          line({ method: "item/started", params: { threadId: SESSION, item: { type: "contextCompaction" } } }),
          line(usage(18130)),
          line({ method: "item/completed", params: { threadId: SESSION, item: { type: "contextCompaction" } } }),
          line({ method: "turn/completed", params: { threadId: SESSION, turn: { status: "completed", error: null } } }),
        ],
      },
    ]);
    const events = await compactCodexThread({ ctx: { cwd: "/tmp", env: {}, host }, threadId: ids().threadId, resumeToken: SESSION }, "codex");
    expect(host.written.map((w) => JSON.parse(w).method)).toEqual(["initialized", "thread/resume", "thread/compact/start"]);
    expect(events).toEqual([
      { type: "context.injected", threadId: ids().threadId, source: "compaction", content: "", compaction: { method: "compact", tokensBefore: 15587, tokensAfter: 18130 } },
      expect.objectContaining({ type: "context.usage", usedTokens: 18130, windowTokens: 475_000, thresholdTokens: 427_500, status: "complete", harness: "codex" }),
    ]);
  });

  it("fails with Codex's reason when the compaction does", async () => {
    const host = new FakeProcessHost([
      {
        match: (argv) => argv[1] === "app-server",
        lines: [line({ id: 1, result: {} }), line({ id: 2, error: { message: "no rollout found for thread id" } })],
      },
    ]);
    await expect(compactCodexThread({ ctx: { cwd: "/tmp", env: {}, host }, threadId: ids().threadId, resumeToken: SESSION }, "codex")).rejects.toThrow(
      "no rollout found",
    );
  });

  it("is what the provider's compact runs", () => {
    expect(typeof new CodexProvider("codex").compact).toBe("function");
  });

  function ids() {
    return { threadId: "22222222-2222-4222-8222-222222222222" };
  }
});
