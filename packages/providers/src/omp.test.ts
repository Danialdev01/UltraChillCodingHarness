import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import { approvalFor, editOperations, OmpNormaliser, ompArgv, thinkingFor, type OmpSessionStats } from "./omp.js";
import type { OmpFrame } from "./omp-rpc-types.js";

const base = {
  bin: "omp",
  overlayPath: "/creds/u/omp/run/t.yml",
  sessionDir: "/creds/u/omp/sessions/p",
  guardHookPath: "/creds/u/omp/agent/ucch-guard.ts",
  trusted: false,
};

describe("ompArgv", () => {
  it("starts an untrusted turn locked down", () => {
    expect(ompArgv(base)).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--config",
      "/creds/u/omp/run/t.yml",
      "--session-dir",
      "/creds/u/omp/sessions/p",
      "--approval-mode",
      "write",
      "--no-extensions",
      "--no-rules",
      "--no-title",
      "--hook",
      "/creds/u/omp/agent/ucch-guard.ts",
      "--no-lsp",
    ]);
  });

  it("resumes, names the model and effort, and appends the system prompt", () => {
    expect(
      ompArgv({
        ...base,
        trusted: true,
        model: "openrouter/anthropic/claude-sonnet-4.5",
        effort: "high",
        resumeToken: "01a18fd3-9a3c",
        permissionMode: "strict",
        appendSystemPrompt: "Project knowledge.",
        maxTime: "45m",
      }).slice(14),
    ).toEqual([
      "--model",
      "openrouter/anthropic/claude-sonnet-4.5",
      "--thinking",
      "high",
      "--resume",
      "01a18fd3-9a3c",
      "--append-system-prompt",
      "Project knowledge.\n",
      "--max-time",
      "45m",
    ]);
  });

  // OMP would replace a value naming an existing file with the file.
  it("always passes the system prompt as text, never as a path", () => {
    const at = (argv: string[]) => argv[argv.indexOf("--append-system-prompt") + 1];
    expect(at(ompArgv({ ...base, appendSystemPrompt: "/etc/passwd" }))).toBe("/etc/passwd\n");
    expect(at(ompArgv({ ...base, appendSystemPrompt: "already ends\n" }))).toBe("already ends\n");
  });

  it("is fixed for every permission mode × effort × resume × trust", () => {
    const table: Record<string, string> = {};
    for (const permissionMode of ["strict", "normal", "allow_all", undefined] as const) {
      for (const effort of ["off", "low", "medium", "high", "xhigh", "max", undefined] as const) {
        for (const resumeToken of [undefined, "s-1"]) {
          for (const trusted of [false, true]) {
            const key = `${permissionMode ?? "-"} ${effort ?? "-"} ${resumeToken ?? "-"} ${trusted ? "trusted" : "untrusted"}`;
            table[key] = ompArgv({
              ...base,
              trusted,
              ...(permissionMode ? { permissionMode } : {}),
              ...(effort ? { effort } : {}),
              ...(resumeToken ? { resumeToken } : {}),
            })
              .slice(1)
              .join(" ");
          }
        }
      }
    }
    expect(table).toMatchSnapshot();
  });

  it("never lets OMP skip its approvals outside allow_all", () => {
    for (const permissionMode of ["strict", "normal", undefined] as const) {
      const argv = ompArgv({ ...base, trusted: true, ...(permissionMode ? { permissionMode } : {}) });
      expect(argv).not.toContain("--yolo");
      expect(argv).not.toContain("yolo");
    }
    expect(ompArgv({ ...base, permissionMode: "allow_all" })).toContain("yolo");
    expect(ompArgv({ ...base, permissionMode: "allow_all" })).not.toContain("--yolo");
  });

  it("keeps the load-bearing flags under every option", () => {
    for (const trusted of [false, true]) {
      const argv = ompArgv({ ...base, trusted, resumeToken: "s", effort: "max", appendSystemPrompt: "x" });
      for (const flag of ["--no-extensions", "--no-rules", "--hook", "--config"]) expect(argv).toContain(flag);
      expect(argv.slice(1, 3)).toEqual(["--mode", "rpc-ui"]);
      expect(argv.includes("--no-lsp")).toBe(!trusted);
    }
  });
});

describe("mappings", () => {
  it("maps permission modes to approval modes", () => {
    expect(approvalFor("strict")).toBe("always-ask");
    expect(approvalFor("normal")).toBe("write");
    expect(approvalFor(undefined)).toBe("write");
    expect(approvalFor("allow_all")).toBe("yolo");
  });

  it("maps effort to --thinking, and off to no flag", () => {
    expect(thinkingFor(undefined)).toBeNull();
    expect(thinkingFor("off")).toBeNull();
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) expect(thinkingFor(effort)).toBe(effort);
  });
});

// -- OmpNormaliser against the OM0 recordings -----------------------------------

const ids = {
  projectId: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  turnId: "00000000-0000-4000-8000-000000000003",
};
const WORKSPACE = "/w";

interface Recorded {
  dir: "in" | "out";
  frame: OmpFrame;
}

function recording(name: string): Recorded[] {
  return readFileSync(join(import.meta.dirname, "fixtures", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Recorded);
}

/**
 * Plays a recording through the normaliser the way the provider does. The
 * provider asks `get_state` right after `ready`, so the session is announced
 * first; the recordings asked it after the turn, so its answer is found and
 * used up front. The `get_session_stats` answer goes to `complete`; every
 * other frame from OMP goes to `push`. Returns the events and what the
 * normaliser sent back.
 */
function replay(name: string) {
  const sent: unknown[] = [];
  let clock = 0;
  const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE, now: () => (clock += 5) });
  normaliser.bind({ send: (frame) => sent.push(frame) });
  const frames = recording(name);
  const state = frames.find(({ frame }) => frame.type === "response" && frame.command === "get_state");
  const events: DomainEvent[] = [];
  if (state) events.push(...normaliser.session(String((state.frame.data as { sessionId?: string }).sessionId)));
  let after: OmpSessionStats | null = null;
  for (const { dir, frame } of frames) {
    if (dir === "in") {
      // The person's answer, as the recording made it.
      if (frame.type === "extension_ui_response" && typeof frame.value === "string") {
        events.push(...normaliser.answerPermission(String(frame.id), { behavior: frame.value === "Approve" ? "allow" : "deny" }));
      }
      continue;
    }
    if (frame.type === "response") {
      if (frame.command === "get_session_stats") after = frame.data as OmpSessionStats;
      continue;
    }
    events.push(...normaliser.push(frame));
  }
  events.push(...(normaliser.settled ? normaliser.complete({ after }) : normaliser.finish({ code: 0, signal: null, interrupted: false, stderrTail: "" })));
  return { events, sent, normaliser };
}

const parsed = (events: DomainEvent[]) => events.map((event) => DomainEvent.parse(event));

describe("OmpNormaliser", () => {
  it("normalises a one-line answer", () => {
    const { events } = replay("omp-plain");
    expect(parsed(events)).toEqual(events);
    expect(events).toEqual([
      { type: "agent.session_started", ...pick(ids), provider: "omp", sessionId: "01a18fd3-9a3c-7089-88f3-a56882f2afa4" },
      ...events.filter((e) => e.type === "agent.text_delta"),
      { type: "agent.message", ...pick(ids), content: [expect.objectContaining({ type: "text" })] },
      {
        type: "agent.turn_completed",
        ...pick(ids),
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        costUsd: 0,
      },
    ]);
    expect(events.filter((e) => e.type === "agent.text_delta").length).toBeGreaterThan(0);
  });

  it.each([
    "omp-plain",
    "omp-tool",
    "omp-confirm",
    "omp-compaction",
    "omp-handoff",
    "omp-subagent",
    "omp-host-tool",
    "omp-host-tool-xd",
    "omp-error",
    "omp-retry",
    "omp-resume",
  ])("produces valid, fixed events for %s", (name) => {
    const { events, sent } = replay(name);
    expect(parsed(events)).toEqual(events);
    expect({ events, sent }).toMatchSnapshot();
  });

  it.each(["omp-plain", "omp-tool", "omp-confirm", "omp-compaction", "omp-subagent", "omp-host-tool-xd", "omp-error", "omp-resume"])(
    "pairs every tool_use with a tool_result in %s, and starts the session before any delta",
    (name) => {
      const { events } = replay(name);
      const uses = events.filter((e) => e.type === "agent.tool_use").map((e) => e.toolUseId);
      const results = events.filter((e) => e.type === "agent.tool_result").map((e) => e.toolUseId);
      expect(results.sort()).toEqual(uses.sort());
      const firstDelta = events.findIndex((e) => e.type === "agent.text_delta" || e.type === "agent.thinking_delta");
      const started = events.findIndex((e) => e.type === "agent.session_started");
      if (started !== -1 && firstDelta !== -1) expect(started).toBeLessThan(firstDelta);
      expect(events.filter((e) => e.type === "agent.turn_completed" || e.type === "agent.turn_failed")).toHaveLength(1);
    },
  );

  it("raises approvals for the running call and answers them with OMP's labels", () => {
    const { events, sent } = replay("omp-confirm");
    const asked = events.filter((e) => e.type === "agent.permission_requested");
    expect(asked).toEqual([
      expect.objectContaining({ requestId: "15bb4296eaba7a53", toolUseId: "call_1", toolName: "bash", input: { command: "ls" }, description: "Command: ls" }),
      expect.objectContaining({ requestId: "15bb4296f3ba7a54", toolUseId: "call_2", toolName: "bash", description: "Command: echo denied-run" }),
    ]);
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "15bb4296eaba7a53", value: "Approve" },
      { type: "extension_ui_response", id: "15bb4296f3ba7a54", value: "Deny" },
    ]);
    const order = events.map((e) => e.type);
    const requested = order.indexOf("agent.permission_requested");
    expect(order.slice(requested, requested + 3)).toEqual(["agent.permission_requested", "agent.permission_resolved", "agent.tool_result"]);
    expect(events.find((e) => e.type === "agent.tool_result" && e.toolUseId === "call_2")).toMatchObject({ isError: true });
  });

  it("fails the turn on an API error even though OMP ended it normally", () => {
    const { events } = replay("omp-error");
    expect(events.at(-1)).toEqual({
      type: "agent.turn_failed",
      ...pick(ids),
      error: expect.stringMatching(/^400 This model does not support that request/),
    });
  });

  it("shows a host tool called through its xd:// device as that tool, and changes no file", () => {
    const { events } = replay("omp-host-tool-xd");
    expect(events.find((e) => e.type === "agent.tool_use")).toMatchObject({ name: "ucch_echo", input: { text: "ping" } });
    expect(events.some((e) => e.type === "file.changed")).toBe(false);
    expect(events.find((e) => e.type === "agent.tool_result")).toMatchObject({ content: "echo: ping", isError: false });
  });

  it("names tools as the native loop does and reports the files they wrote", () => {
    const { events } = replay("omp-tool");
    expect(events.filter((e) => e.type === "agent.tool_use").map((e) => e.name)).toEqual(["read_file", "write_file"]);
    expect(events.filter((e) => e.type === "file.changed")).toEqual([
      { type: "file.changed", projectId: ids.projectId, path: "summary.txt", change: "modified" },
    ]);
  });

  it("stores tool calls as the tool_use blocks the event log already replays", () => {
    const { events } = replay("omp-tool");
    const blocks = events.flatMap((e) => (e.type === "agent.message" ? e.content : []));
    expect(blocks).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { i: "read the notes", path: "notes.txt" },
      arguments: '{"i":"read the notes","path":"notes.txt"}',
    });
    expect(blocks.some((block) => (block as { type: string }).type === "toolCall")).toBe(false);
  });

  it("records each compaction's summary, and nothing for a skipped one", () => {
    const { events } = replay("omp-compaction");
    const injected = events.filter((e) => e.type === "context.injected");
    expect(injected).toHaveLength(2);
    for (const e of injected) expect(e).toMatchObject({ source: "compaction", content: expect.stringContaining("Summary: the session so far.") });
  });

  it("waits for the terminal agent_end, not the one before background work", () => {
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    normaliser.push({ type: "agent_end", isTerminal: false, awaitingAsyncWork: true });
    normaliser.push({ type: "prompt_result", status: "completed" });
    expect(normaliser.settled).toBe(false);
    normaliser.push({ type: "agent_end", isTerminal: true });
    expect(normaliser.settled).toBe(true);
  });

  it("cancels dialogs the chat cannot show, and ignores notifications", () => {
    const sent: unknown[] = [];
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    normaliser.bind({ send: (frame) => sent.push(frame) });
    expect(normaliser.push({ type: "extension_ui_request", id: "q1", method: "input", title: "Your name?" })).toEqual([]);
    expect(normaliser.push({ type: "extension_ui_request", id: "q2", method: "select", title: "Pick one", options: ["a"] })).toEqual([]);
    expect(normaliser.push({ type: "extension_ui_request", id: "n1", method: "setWidget", widgetKey: "x" })).toEqual([]);
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "q1", cancelled: true },
      { type: "extension_ui_response", id: "q2", cancelled: true },
    ]);
  });

  it("produces nothing for unknown frames", () => {
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    expect(normaliser.push({ type: "brand_new_frame", payload: 1 })).toEqual([]);
    expect(normaliser.push({ type: "notice", level: "warning", message: "x" })).toEqual([]);
  });

  it("closes an interrupted turn as cancelled, and answers its open approvals", () => {
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    normaliser.push({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 9" } });
    normaliser.push({ type: "extension_ui_request", id: "r1", method: "select", title: "Allow tool: bash", options: [] });
    normaliser.noteInterrupt();
    expect(normaliser.finish({ code: 0, signal: null, interrupted: true, stderrTail: "" })).toEqual([
      { type: "agent.permission_resolved", ...pick(ids), requestId: "r1", behavior: "deny" },
      expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" }),
    ]);
  });

  it("fails a turn whose process died, with stderr as the reason", () => {
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    expect(normaliser.finish({ code: 1, signal: null, interrupted: false, stderrTail: 'Session "abc" not found' })).toEqual([
      { type: "agent.turn_failed", ...pick(ids), error: 'Session "abc" not found' },
    ]);
  });

  it("charges the turn the difference in session totals", () => {
    const normaliser = new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    normaliser.push({ type: "agent_end", isTerminal: true });
    normaliser.push({ type: "prompt_result", status: "completed" });
    const [done] = normaliser.complete({
      before: { tokens: { input: 1000, output: 100, cacheRead: 50, cacheWrite: 10 }, cost: 0.01 },
      after: { tokens: { input: 1500, output: 160, cacheRead: 80, cacheWrite: 10 }, cost: 0.0175 },
    });
    expect(done).toMatchObject({
      usage: { inputTokens: 500, outputTokens: 60, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 },
      costUsd: expect.closeTo(0.0075, 10),
    });
  });

  it("reads the files an edit patch touches", () => {
    expect(editOperations("[a.ts#A1B2]\nPUT 1.=1:\n+x\n[b.ts#00FF]\nREM\n[c.ts#1234]\nMV d.ts\n")).toEqual([
      { path: "a.ts", removed: false, movedTo: null },
      { path: "b.ts", removed: true, movedTo: null },
      { path: "c.ts", removed: false, movedTo: "d.ts" },
    ]);
  });
});

function pick(all: typeof ids) {
  return { threadId: all.threadId, turnId: all.turnId };
}
