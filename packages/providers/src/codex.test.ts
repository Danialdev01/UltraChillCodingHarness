import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import { CodexNormaliser, CodexProvider, codexArgv, codexPrompt, probeCodex } from "./codex.js";
import { FakeProcessHost, stdout } from "./testing.js";

const WORKSPACE = "/srv/ucch/workspaces/11111111-1111-4111-8111-111111111111";
const ids = {
  projectId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "codex-edit.jsonl"), "utf8");

function feed(normaliser: CodexNormaliser, text: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const line of text.split("\n")) events.push(...normaliser.push(line));
  return events;
}

describe("codexArgv", () => {
  const caps = { ignoreRules: true };

  it("asks for JSON and a writable sandbox", () => {
    const argv = codexArgv({ bin: "codex", isRepo: true, caps });
    expect(argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(argv).toContain("--json");
    expect(argv.join(" ")).toContain("--sandbox workspace-write");
    expect(argv).toContain("--ignore-rules");
    expect(argv).not.toContain("--skip-git-repo-check");
  });

  // Ephemeral skips the rollout file that resume needs.
  it("never passes --ephemeral or full access", () => {
    for (const argv of [
      codexArgv({ bin: "codex", isRepo: true, caps }),
      codexArgv({ bin: "codex", isRepo: false, caps, resumeToken: "t", model: "gpt-5" }),
    ]) {
      expect(argv).not.toContain("--ephemeral");
      expect(argv).not.toContain("danger-full-access");
    }
  });

  it("resumes with the positional form and skips the repo check off a repo", () => {
    const argv = codexArgv({ bin: "codex", isRepo: false, caps: { ignoreRules: false }, resumeToken: "th-1", model: "gpt-5" });
    expect(argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "th-1"]);
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).not.toContain("--ignore-rules");
    expect(argv.join(" ")).toContain("--model gpt-5");
  });
});

describe("codexPrompt", () => {
  it("puts the project's knowledge ahead of a new session's message only", () => {
    expect(codexPrompt("fix it", "INFO")).toBe("<project-knowledge>\nINFO\n</project-knowledge>\n\nfix it");
    expect(codexPrompt("fix it", "INFO", "th-1")).toBe("fix it");
    expect(codexPrompt("fix it")).toBe("fix it");
  });
});

describe("CodexNormaliser", () => {
  let clock = 0;
  const events = feed(new CodexNormaliser({ ...ids, workspace: WORKSPACE, now: () => (clock += 100) }), fixture);

  it("opens the session from thread.started", () => {
    expect(events[0]).toEqual({
      type: "agent.session_started",
      threadId: ids.threadId,
      turnId: ids.turnId,
      provider: "codex",
      sessionId: "0199a213-7f52-7b21-9d3b-0c4f4d0a7d11",
    });
  });

  it("maps reasoning to a thinking delta", () => {
    expect(events[1]).toMatchObject({ type: "agent.thinking_delta", text: "I should look at the file first." });
  });

  it("maps a command to a bash tool call and result with a duration", () => {
    const use = events.find((e) => e.type === "agent.tool_use" && e.toolUseId === "item_1");
    const result = events.find((e) => e.type === "agent.tool_result" && e.toolUseId === "item_1");
    expect(use).toMatchObject({ name: "bash", input: { command: "bash -lc ls" } });
    expect(result).toMatchObject({ content: "README.md\nsrc\n", isError: false, durationMs: 100 });
  });

  it("turns a file_change into a tool row and workspace-relative file events", () => {
    const changed = events.filter((e) => e.type === "file.changed");
    expect(changed).toEqual([
      { type: "file.changed", projectId: ids.projectId, path: "src/index.ts", change: "modified" },
      { type: "file.changed", projectId: ids.projectId, path: "docs/new.md", change: "added" },
    ]);
    const use = events.find((e) => e.type === "agent.tool_use" && e.toolUseId === "item_2");
    expect(use).toMatchObject({ name: "file_change" });
  });

  it("streams a whole message as one delta and stores it durably", () => {
    const delta = events.find((e) => e.type === "agent.text_delta");
    const message = events.find((e) => e.type === "agent.message");
    expect(delta).toMatchObject({ text: "I updated the entry point and added a doc." });
    expect(message).toMatchObject({ content: [{ type: "text", text: "I updated the entry point and added a doc." }] });
  });

  it("closes the turn with the usage figures", () => {
    expect(events.at(-1)).toEqual({
      type: "agent.turn_completed",
      threadId: ids.threadId,
      turnId: ids.turnId,
      stopReason: "end_turn",
      usage: { inputTokens: 24763, outputTokens: 122, cacheReadInputTokens: 24448, cacheCreationInputTokens: 0 },
      costUsd: 0,
    });
  });

  it("maps failures and a failed command", () => {
    const n = new CodexNormaliser({ ...ids, workspace: WORKSPACE });
    expect(n.push(JSON.stringify({ type: "turn.failed", error: { message: "quota exhausted" } }))).toEqual([
      { type: "agent.turn_failed", threadId: ids.threadId, turnId: ids.turnId, error: "quota exhausted" },
    ]);
    const m = new CodexNormaliser({ ...ids, workspace: WORKSPACE });
    const [use, result] = m.push(
      JSON.stringify({ type: "item.completed", item: { id: "c", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } }),
    );
    expect(use?.type).toBe("agent.tool_use");
    expect(result).toMatchObject({ type: "agent.tool_result", isError: true });
  });

  it("closes an interrupted run as cancelled", () => {
    const n = new CodexNormaliser({ ...ids, workspace: WORKSPACE });
    expect(n.finish({ code: null, signal: "SIGINT", interrupted: true, stderrTail: "" })).toEqual([
      expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" }),
    ]);
  });
});

describe("probeCodex", () => {
  const ctx = (host: FakeProcessHost) => ({ cwd: "/tmp", env: { PATH: "/usr/bin" }, host });

  it("reports not installed, with the warning, when the binary is absent", async () => {
    const health = await probeCodex(ctx(new FakeProcessHost([])), "codex");
    expect(health).toMatchObject({ installed: false, authenticated: false, authMode: "none" });
    expect(health.warnings?.[0]).toMatch(/advanced path/);
  });

  it("reads the login status prose", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "--version", lines: [stdout("codex-cli 0.42.0")] },
      { match: (a) => a[1] === "exec", lines: [stdout("--ignore-rules")] },
      { match: (a) => a[1] === "login", lines: [stdout("Logged in using ChatGPT")] },
    ]);
    const health = await probeCodex(ctx(host), "codex");
    expect(health).toMatchObject({ installed: true, authenticated: true, authMode: "subscription", version: "0.42.0" });
    expect(health.caps.ignoreRules).toBe(true);
  });

  it("treats a non-zero login status as signed out", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[1] === "--version", lines: [stdout("codex-cli 0.42.0")] },
      { match: (a) => a[1] === "exec", lines: [] },
      { match: (a) => a[1] === "login", lines: [stdout("Not logged in")], exit: { code: 1, signal: null } },
    ]);
    expect(await probeCodex(ctx(host), "codex")).toMatchObject({ authenticated: false, authMode: "none" });
  });
});

describe("CodexProvider.run", () => {
  it("feeds the prompt on stdin and refuses an API key", async () => {
    const host = new FakeProcessHost([{ match: (a) => a[1] === "exec", lines: fixture.trim().split("\n").map(stdout) }]);
    const provider = new CodexProvider("codex", () => false);
    const run = provider.run({ ctx: { cwd: WORKSPACE, env: { PATH: "/usr/bin", CODEX_HOME: "/creds" }, host }, prompt: "fix it", ...ids });
    const events: DomainEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(host.spawned[0]?.stdin).toBe("fix it");
    expect(host.spawned[0]?.argv).toContain("--skip-git-repo-check");
    expect(events.at(-1)?.type).toBe("agent.turn_completed");

    expect(() =>
      provider.run({ ctx: { cwd: WORKSPACE, env: { OPENAI_API_KEY: "sk" }, host }, prompt: "x", ...ids }),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
