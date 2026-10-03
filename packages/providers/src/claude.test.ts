import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import {
  ClaudeNormaliser,
  ClaudeProvider,
  claudeArgv,
  maskEmail,
  probeClaude,
  workspaceRelative,
} from "./claude.js";
import { splitLines } from "./process.js";
import { FakeProcessHost, stdout } from "./testing.js";

const WORKSPACE = "/srv/ucch/workspaces/11111111-1111-4111-8111-111111111111";
const ids = {
  projectId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `claude-${name}.jsonl`), "utf8");

function feed(normaliser: ClaudeNormaliser, text: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const line of text.split("\n")) events.push(...normaliser.push(line));
  return events;
}

const caps = { permissionPrompts: true, settingSources: true };

describe("claudeArgv", () => {
  it("names the stream, a permission mode and no prompt host", () => {
    const argv = claudeArgv({ bin: "claude", caps });
    expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--include-partial-messages");
    expect(argv.join(" ")).toContain("--permission-mode acceptEdits");
    expect(argv.join(" ")).toContain("--permission-prompts none");
    expect(argv.join(" ")).toContain("--setting-sources user");
  });

  // Bare mode does not read OAuth credentials or CLAUDE_CODE_OAUTH_TOKEN. It
  // is the documented recommendation for scripts and exactly wrong here.
  it("never passes --bare and never bypasses permissions", () => {
    for (const argv of [
      claudeArgv({ bin: "claude", caps }),
      claudeArgv({ bin: "claude", caps, model: "opus", resumeToken: "abc" }),
      claudeArgv({ bin: "claude", caps: { permissionPrompts: false, settingSources: false } }),
    ]) {
      expect(argv).not.toContain("--bare");
      expect(argv).not.toContain("bypassPermissions");
    }
  });

  it("starts in default mode under Strict, so edits ask too", () => {
    expect(claudeArgv({ bin: "claude", caps, permissionMode: "strict" }).join(" ")).toContain(
      "--permission-mode default",
    );
    expect(claudeArgv({ bin: "claude", caps, permissionMode: "normal" }).join(" ")).toContain(
      "--permission-mode acceptEdits",
    );
    expect(claudeArgv({ bin: "claude", caps, permissionMode: "allow_all" })).not.toContain(
      "bypassPermissions",
    );
  });

  it("drops flags the installed CLI lacks", () => {
    const argv = claudeArgv({ bin: "claude", caps: { permissionPrompts: false, settingSources: false } });
    expect(argv).not.toContain("--permission-prompts");
    expect(argv).not.toContain("--setting-sources");
  });

  it("resumes by session id and pins a model when asked", () => {
    const argv = claudeArgv({ bin: "claude", caps, model: "sonnet", resumeToken: "sess-1" });
    expect(argv.join(" ")).toContain("--resume sess-1");
    expect(argv.join(" ")).toContain("--model sonnet");
  });

  // The prompt is not in argv at all: it travels on stdin.
  it("keeps the prompt out of argv", () => {
    const argv = claudeArgv({ bin: "claude", caps });
    expect(argv.some((a) => a.includes("pong"))).toBe(false);
  });
});

describe("ClaudeNormaliser on a text-only turn", () => {
  it("opens the session, streams deltas, stores the message and closes the turn", () => {
    const events = feed(new ClaudeNormaliser({ ...ids, workspace: WORKSPACE }), fixture("text"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent.session_started");
    expect(types.filter((t) => t === "agent.text_delta")).toHaveLength(2);
    expect(types.at(-2)).toBe("agent.message");
    expect(types.at(-1)).toBe("agent.turn_completed");

    const session = events[0] as Extract<DomainEvent, { type: "agent.session_started" }>;
    expect(session).toMatchObject({ provider: "claude", sessionId: "b300e076-5338-4ecc-9939-0d9c8a72be70" });

    const text = events
      .filter((e): e is Extract<DomainEvent, { type: "agent.text_delta" }> => e.type === "agent.text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("pong");

    // One durable message per response, assembled from the per-block lines.
    const messages = events.filter((e) => e.type === "agent.message");
    expect(messages).toHaveLength(1);
    const content = (messages[0] as Extract<DomainEvent, { type: "agent.message" }>).content as {
      type: string;
    }[];
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"]);

    const done = events.at(-1) as Extract<DomainEvent, { type: "agent.turn_completed" }>;
    expect(done.stopReason).toBe("end_turn");
    expect(done.usage).toEqual({
      inputTokens: 9,
      outputTokens: 44,
      cacheReadInputTokens: 12224,
      cacheCreationInputTokens: 7205,
    });
    expect(done.costUsd).toBeCloseTo(0.0158614, 6);
  });

  it("produces the same events when the stream is split mid-line", () => {
    const whole = feed(new ClaudeNormaliser({ ...ids, workspace: WORKSPACE }), fixture("text"));
    const normaliser = new ClaudeNormaliser({ ...ids, workspace: WORKSPACE });
    const splitter = splitLines();
    const events: DomainEvent[] = [];
    const text = fixture("text");
    for (let at = 0; at < text.length; at += 7) {
      for (const line of splitter.push(text.slice(at, at + 7))) events.push(...normaliser.push(line));
    }
    const tail = splitter.flush();
    if (tail) events.push(...normaliser.push(tail));
    expect(events).toEqual(whole);
  });

  it("ignores lines that are not JSON, and JSON it does not know", () => {
    const n = new ClaudeNormaliser({ ...ids, workspace: WORKSPACE });
    expect(n.push("")).toEqual([]);
    expect(n.push("warning: something")).toEqual([]);
    expect(n.push('{"type":"rate_limit_event"}')).toEqual([]);
    expect(n.push('{"type":"system","subtype":"status"}')).toEqual([]);
    expect(n.push("{not json")).toEqual([]);
  });
});

describe("ClaudeNormaliser on a turn that writes a file", () => {
  let clock = 1_000;
  const events = feed(
    new ClaudeNormaliser({ ...ids, workspace: WORKSPACE, now: () => (clock += 250) }),
    fixture("write"),
  );

  it("records the tool call before its result, with a duration", () => {
    const use = events.find((e) => e.type === "agent.tool_use") as Extract<
      DomainEvent,
      { type: "agent.tool_use" }
    >;
    const result = events.find((e) => e.type === "agent.tool_result") as Extract<
      DomainEvent,
      { type: "agent.tool_result" }
    >;
    expect(use).toMatchObject({ toolUseId: "toolu_01MXTPo6xNnz61rL1tDT9E8g", name: "Write" });
    expect((use.input as { file_path: string }).file_path).toBe(`${WORKSPACE}/hello.txt`);
    expect(result.toolUseId).toBe(use.toolUseId);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/File created successfully/);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(events.indexOf(use)).toBeLessThan(events.indexOf(result));
  });

  it("emits a workspace-relative file.changed after a successful write", () => {
    const changed = events.filter((e) => e.type === "file.changed");
    expect(changed).toEqual([
      { type: "file.changed", projectId: ids.projectId, path: "hello.txt", change: "added" },
    ]);
  });

  it("stores one agent.message per model response", () => {
    // Response one: thinking + tool_use. Response two: thinking + "done".
    const messages = events.filter((e) => e.type === "agent.message");
    expect(messages).toHaveLength(2);
  });

  it("writes the message that holds a tool call before the tool_use event", () => {
    const types = events.map((e) => e.type);
    const use = types.indexOf("agent.tool_use");
    expect(types[use - 1]).toBe("agent.message");
  });
});

describe("ClaudeNormaliser edge cases", () => {
  const n = () => new ClaudeNormaliser({ ...ids, workspace: WORKSPACE });

  it("maps a failed result to turn_failed", () => {
    const events = n().push(
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "hit the cap" }),
    );
    expect(events).toEqual([{ type: "agent.turn_failed", threadId: ids.threadId, turnId: ids.turnId, error: "hit the cap" }]);
  });

  it("does not report a file change for a failed edit", () => {
    const normaliser = n();
    normaliser.push(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${WORKSPACE}/a.ts` } }],
        },
      }),
    );
    const events = normaliser.push(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "no match", is_error: true }] },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.tool_result"]);
    expect((events[0] as { isError: boolean }).isError).toBe(true);
  });

  it("ignores an edit outside the workspace", () => {
    const normaliser = n();
    normaliser.push(
      JSON.stringify({
        type: "assistant",
        message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/etc/hosts" } }] },
      }),
    );
    const events = normaliser.push(
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.tool_result"]);
  });

  it("skips subagent prose but keeps the retry note", () => {
    const normaliser = n();
    expect(
      normaliser.push(
        JSON.stringify({
          type: "stream_event",
          parent_tool_use_id: "toolu_parent",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "inner" } },
        }),
      ),
    ).toEqual([]);
    expect(
      normaliser.push(
        JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 500, error: { type: "overloaded_error" } }),
      ),
    ).toEqual([
      { type: "agent.retry", threadId: ids.threadId, turnId: ids.turnId, attempt: 2, maxRetries: 10, delayMs: 500, category: "overloaded_error" },
    ]);
  });

  it("closes an interrupted run as cancelled and a crashed one as failed", () => {
    const cancelled = n().finish({ code: 143, signal: null, interrupted: true, stderrTail: "" });
    expect(cancelled).toEqual([
      expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" }),
    ]);
    const crashed = n().finish({ code: 1, signal: null, interrupted: false, stderrTail: "Not logged in" });
    expect(crashed).toEqual([
      expect.objectContaining({ type: "agent.turn_failed", error: "claude exited with Not logged in" }),
    ]);
  });

  it("reads the result line an interrupt produces as a cancellation", () => {
    const interrupted = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: null,
      terminal_reason: "aborted_streaming",
      total_cost_usd: 0.001,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    // Whether we sent the signal ourselves...
    const ours = n();
    ours.noteInterrupt();
    expect(ours.push(interrupted)).toEqual([
      expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" }),
    ]);
    // ...or the CLI says it was aborted: still not a failure.
    expect(n().push(interrupted)).toEqual([
      expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" }),
    ]);
    // A genuine error without either stays a failure.
    expect(n().push(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }))).toEqual([
      expect.objectContaining({ type: "agent.turn_failed", error: "boom" }),
    ]);
  });

  it("emits nothing from finish when the result line already closed the turn", () => {
    const normaliser = n();
    normaliser.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }));
    expect(normaliser.finish({ code: 0, signal: null, interrupted: false, stderrTail: "" })).toEqual([]);
  });
});

describe("workspaceRelative", () => {
  it("accepts paths inside the workspace, absolute or not", () => {
    expect(workspaceRelative(WORKSPACE, `${WORKSPACE}/src/a.ts`)).toBe("src/a.ts");
    expect(workspaceRelative(WORKSPACE, "src/./b.ts")).toBe("src/b.ts");
  });
  it("refuses the root itself and anything outside", () => {
    expect(workspaceRelative(WORKSPACE, WORKSPACE)).toBeNull();
    expect(workspaceRelative(WORKSPACE, "/etc/hosts")).toBeNull();
    expect(workspaceRelative(WORKSPACE, "../other/x")).toBeNull();
    expect(workspaceRelative(WORKSPACE, `${WORKSPACE}-other/x`)).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("danial@example.com")).toBe("d***@example.com");
    expect(maskEmail("nonsense")).toBe("***");
  });
});

describe("probeClaude", () => {
  const ctx = (host: FakeProcessHost, env: Record<string, string> = {}) => ({
    cwd: "/tmp",
    env: { PATH: "/usr/bin", ...env },
    host,
  });

  it("reports a fresh install as installed but signed out", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "--version", lines: [stdout("2.1.270 (Claude Code)")] },
      { match: (a) => a[1] === "-p" && a[2] === "--help", lines: [stdout("--permission-prompts <target>\n--setting-sources <s>")] },
      { match: (a) => a[1] === "auth", lines: [stdout('{"loggedIn":false}')], exit: { code: 1, signal: null } },
    ]);
    const health = await probeClaude(ctx(host), "claude");
    expect(health).toMatchObject({ installed: true, authenticated: false, authMode: "none", version: "2.1.270" });
    expect(health.caps).toEqual({ permissionPrompts: true, settingSources: true });
    expect(health.account).toBeUndefined();
  });

  it("masks the account of a signed-in subscription", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "--version", lines: [stdout("2.1.270 (Claude Code)")] },
      { match: (a) => a[1] === "-p", lines: [] },
      {
        match: (a) => a[1] === "auth",
        lines: [stdout(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "danial@example.com", subscriptionType: "pro" }))],
      },
    ]);
    const health = await probeClaude(ctx(host), "claude");
    expect(health).toMatchObject({ authenticated: true, authMode: "subscription", account: "d***@example.com" });
    expect(JSON.stringify(health)).not.toContain("danial@");
  });

  it("calls the pasted token mode by its name", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "--version", lines: [stdout("2.1.270")] },
      { match: (a) => a[1] === "-p", lines: [] },
      { match: (a) => a[1] === "auth", lines: [stdout('{"loggedIn":true,"authMethod":"claude.ai"}')] },
    ]);
    const health = await probeClaude(ctx(host, { CLAUDE_CODE_OAUTH_TOKEN: "x" }), "claude");
    expect(health.authMode).toBe("token");
  });

  it("reports a missing binary without throwing", async () => {
    const host = new FakeProcessHost([]);
    const health = await probeClaude(ctx(host), "claude");
    expect(health).toMatchObject({ installed: false, authenticated: false, authMode: "none" });
  });

  it("warns when an API key is in the environment", async () => {
    const host = new FakeProcessHost([]);
    const health = await probeClaude(ctx(host, { ANTHROPIC_API_KEY: "sk" }), "claude");
    expect(health.warnings?.[0]).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe("ClaudeProvider.run", () => {
  const input = (host: FakeProcessHost, env: Record<string, string> = {}) => ({
    ctx: { cwd: WORKSPACE, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/creds", ...env }, host },
    prompt: "say pong",
    ...ids,
  });

  it("feeds the prompt on stdin and yields the normalised stream", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "-p", lines: fixture("text").trim().split("\n").map(stdout) },
    ]);
    const run = new ClaudeProvider("claude").run(input(host));
    const events: DomainEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(host.spawned[0]?.stdin).toBe("say pong");
    expect(host.spawned[0]?.env.CLAUDE_CONFIG_DIR).toBe("/creds");
    expect(events[0]?.type).toBe("agent.session_started");
    expect(events.at(-1)?.type).toBe("agent.turn_completed");
  });

  it("refuses to run with an API key in the environment", () => {
    const host = new FakeProcessHost([]);
    expect(() => new ClaudeProvider("claude").run(input(host, { ANTHROPIC_API_KEY: "sk" }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("interrupts with SIGINT and closes the turn as cancelled", async () => {
    const host = new FakeProcessHost([
      {
        match: (a) => a[1] === "-p",
        lines: [stdout(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }))],
        waitForSignal: "SIGINT",
        exit: { code: 130, signal: null },
      },
    ]);
    const run = new ClaudeProvider("claude").run(input(host));
    const events: DomainEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "agent.session_started") await run.interrupt();
    }
    expect(host.signals).toEqual(["SIGINT"]);
    expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed", stopReason: "cancelled" });
  });

  it("fails the turn when the process dies without a result", async () => {
    const host = new FakeProcessHost([
      {
        match: (a) => a[1] === "-p",
        lines: [{ stream: "stderr", line: "Not logged in. Please run /login." }],
        exit: { code: 1, signal: null },
      },
    ]);
    const run = new ClaudeProvider("claude").run(input(host));
    const events: DomainEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ type: "agent.turn_failed", error: expect.stringContaining("Not logged in") }),
    ]);
  });
});
