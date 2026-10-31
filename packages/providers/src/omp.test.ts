import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import {
  approvalFor,
  editOperations,
  describeCompaction,
  OmpNormaliser,
  OmpProvider,
  ompArgv,
  ompPrintArgv,
  ompModel,
  probeOmp,
  thinkingFor,
  type OmpProviderOptions,
  type OmpMaintenanceInput,
  type OmpSessionStats,
} from "./omp.js";
import type { OmpFrame } from "./omp-rpc-types.js";
import { FakeProcessHost, ManualProcessHost, stdout } from "./testing.js";
import type { AgentRun, ProviderRunInput } from "./types.js";

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
    // The frame's own figure; the method and the size after are asked for.
    expect(injected.map((e) => (e as { compaction?: unknown }).compaction)).toEqual([{ tokensBefore: 7832 }, { tokensBefore: 7383 }]);
  });

  it("takes a compaction's method and size after from the session's summary message", () => {
    const answer = recording("omp-compaction").find((r) => r.frame.type === "response" && r.frame.command === "get_messages")!;
    const messages = (answer.frame.data as { messages: unknown[] }).messages;
    const injected = replay("omp-compaction").events.filter((e) => e.type === "context.injected").at(-1)!;
    expect(describeCompaction(injected as never, messages).compaction).toEqual({ method: "soft", tokensBefore: 7383, tokensAfter: 7363 });
    // Another compaction's message, or none at all, leaves the event as it was.
    const other = { ...(injected as object), content: "a different summary" };
    expect(describeCompaction(other as never, messages)).toEqual(other);
    // The same summary from an earlier compaction: its size before differs.
    const first = replay("omp-compaction").events.find((e) => e.type === "context.injected")!;
    expect(describeCompaction(first as never, messages)).toEqual(first);
    expect(describeCompaction(injected as never, undefined)).toEqual(injected);
  });

  it("reads the context's size from the stats, resolving the threshold as OMP does", () => {
    const stats = (tokens: unknown, contextWindow?: unknown): OmpSessionStats => ({ contextUsage: { tokens, contextWindow } as never });
    const usage = (normaliser: OmpNormaliser, ...args: Parameters<OmpNormaliser["usage"]>) =>
      normaliser.usage(...args).map((e) => {
        const { usedTokens, windowTokens, thresholdTokens } = e as Extract<DomainEvent, { type: "context.usage" }>;
        return [usedTokens, windowTokens, thresholdTokens];
      });
    const n = () => new OmpNormaliser({ ...ids, workspace: WORKSPACE });
    expect(usage(n(), stats(100, 128000))).toEqual([[100, 128000, null]]);
    // Tokens win over a percent; a percent is of the window, clamped to 1-99, rounded down.
    expect(usage(n(), stats(100, 128000), { tokens: 90000, percent: 50 })).toEqual([[100, 128000, 90000]]);
    expect(usage(n(), stats(100, 1001), { percent: 50 })).toEqual([[100, 1001, 500]]);
    expect(usage(n(), stats(100, 1000), { percent: 150 })).toEqual([[100, 1000, 990]]);
    // A percent with no window to take it of is no threshold.
    expect(usage(n(), stats(100), { percent: 50 })).toEqual([[100, null, null]]);
    // No size, no reading.
    expect(usage(n(), { tokens: { input: 1 } })).toEqual([]);
    expect(usage(n(), null)).toEqual([]);
    // The same reading twice is sent once; a closed turn sends none.
    const once = n();
    expect(usage(once, stats(100, 128000))).toHaveLength(1);
    expect(usage(once, stats(100, 128000))).toEqual([]);
    expect(usage(once, stats(120, 128000))).toHaveLength(1);
    once.complete();
    expect(usage(once, stats(140, 128000))).toEqual([]);
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

// -- OmpProvider against a fake OMP ---------------------------------------------

const STATS_BEFORE = { tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 };
const STATS_AFTER = { tokens: { input: 1300, output: 140, cacheRead: 20, cacheWrite: 0 }, cost: 0.014 };
const SESSION = "01a18fd3-9a3c-7089-88f3-a56882f2afa4";
const FILES = { overlayPath: "/c/omp/run/t.yml", sessionDir: "/c/omp/sessions/p", guardHookPath: "/c/omp/agent/ucch-guard.ts", trusted: true };

interface FakeOptions {
  /** The frames a prompt streams; an approval waits for its answer. */
  turn?: OmpFrame[];
  /** Stream only this many frames, then wait for an abort. 8 is two deltas into omp-plain. */
  stallAfter?: number;
  /** Ignore `abort` altogether. */
  deaf?: boolean;
  /** Answer `prompt` with this failure. */
  refusePrompt?: string;
  /** Answer `set_host_tools` with this failure. */
  refuseHostTools?: string;
  /** What `get_messages` answers; `false` refuses it. */
  messages?: unknown[] | false;
  /** What each `get_session_stats` answers, in turn; the last repeats. Default: before, then after. */
  stats?: OmpSessionStats[];
  /** How `compact` / `handoff` go: refused with a reason, skipped, or answered with no summary written. */
  fold?: { refuse?: string; skipped?: string; silent?: boolean; hang?: boolean };
}

/** The frames a recording streamed for its first prompt, up to its `prompt_result`. */
function promptFrames(name: string): OmpFrame[] {
  const out = recording(name).filter((r) => r.dir === "out").map((r) => r.frame);
  const start = out.findIndex((f) => f.type === "response" && f.command === "prompt");
  const end = out.findIndex((f) => f.type === "prompt_result");
  return out.slice(start + 1, end + 1).filter((f) => f.type !== "response");
}

/**
 * OMP as 18.14.1 behaves on the wire: ready, v2, answers by id, a prompt
 * that streams `turn`, an approval that holds the stream until answered,
 * an `abort` that is held while a dialog is open (OM2.4), a host call that
 * holds the stream until its result and is cancelled by an `abort` (OM3.2),
 * and an exit when stdin closes.
 */
function fakeOmp(options: FakeOptions = {}) {
  let stats = 0;
  return new ManualProcessHost((child) => {
    const folded: unknown[] = [];
    const emit = (frame: object) => child.emit(JSON.stringify(frame));
    const respond = (frame: Record<string, unknown>, data?: unknown, extra: object = {}) =>
      emit({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }), ...extra });
    let queue: OmpFrame[] = [];
    let waitingOn: string | null = null;
    let waitingOnHost = false;
    let heldAbort: Record<string, unknown> | null = null;
    let aborted = false;
    const pump = () => {
      while (queue.length && !waitingOn) {
        const frame = queue.shift()!;
        emit(frame);
        if (frame.type === "extension_ui_request" && frame.method === "select") waitingOn = String(frame.id);
        if (frame.type === "host_tool_call") {
          waitingOn = String(frame.id);
          waitingOnHost = true;
        }
      }
    };
    const abort = (frame: Record<string, unknown>) => {
      respond(frame);
      if (aborted) return;
      aborted = true;
      if (waitingOnHost && waitingOn) {
        // OMP ends a running host call itself and tells the host so.
        emit({ type: "host_tool_cancel", id: "cancel-1", targetId: waitingOn });
        waitingOn = null;
        waitingOnHost = false;
      }
      queue = [
        { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Interrupted by user" } },
        { type: "agent_end", isTerminal: true },
        { type: "prompt_result", status: "aborted" },
      ];
      pump();
    };
    child.onWrite = (written) => {
      const frame = JSON.parse(written) as Record<string, unknown>;
      switch (frame.type) {
        case "negotiate_protocol":
          return respond(frame, { protocolVersion: 2 });
        case "get_state":
          return respond(frame, { sessionId: SESSION });
        case "get_session_stats":
          if (options.stats) return respond(frame, options.stats[Math.min(stats++, options.stats.length - 1)]);
          return respond(frame, stats++ === 0 ? STATS_BEFORE : STATS_AFTER);
        case "prompt":
          if (options.refusePrompt) return respond(frame, undefined, { success: false, error: options.refusePrompt });
          respond(frame);
          queue = [...(options.turn ?? promptFrames("omp-plain"))];
          if (options.stallAfter !== undefined) queue = queue.slice(0, options.stallAfter);
          return pump();
        case "abort":
          if (options.deaf) return;
          if (waitingOn && !waitingOnHost) heldAbort = frame;
          else abort(frame);
          return;
        case "get_messages":
          if (options.messages === false) return respond(frame, undefined, { success: false, error: "no session" });
          return respond(frame, { messages: [...(options.messages ?? []), ...folded] });
        case "compact":
        case "handoff": {
          const fold = options.fold ?? {};
          if (fold.hang) return;
          if (fold.refuse) return respond(frame, undefined, { success: false, error: fold.refuse });
          if (fold.skipped) return respond(frame, { skipped: true, errorMessage: fold.skipped });
          const summary = `${frame.type} summary${frame.customInstructions ? `: ${String(frame.customInstructions)}` : ""}`;
          const method = frame.type === "handoff" ? "handoff" : "soft";
          if (!fold.silent) folded.push({ role: "compactionSummary", summary, tokensBefore: 9000, tokensAfter: 1500, method });
          if (frame.type === "handoff") return respond(frame, {});
          emit({ type: "manual_compaction_end", result: { summary, tokensBefore: 9000 }, aborted: false });
          return respond(frame, { summary, tokensBefore: 9000 });
        }
        case "set_host_tools":
          if (options.refuseHostTools) return respond(frame, undefined, { success: false, error: options.refuseHostTools });
          return respond(frame, { toolNames: (frame.tools as { name: string }[]).map((tool) => tool.name) });
        case "host_tool_result":
          if (frame.id !== waitingOn || !waitingOnHost) return;
          waitingOn = null;
          waitingOnHost = false;
          return pump();
        case "extension_ui_response":
          if (frame.id !== waitingOn) return;
          waitingOn = null;
          if (heldAbort) abort(heldAbort);
          else pump();
          return;
        default:
          if (typeof frame.id === "string") respond(frame, {});
      }
    };
    const endStdin = child.handle.endStdin;
    child.handle.endStdin = () => {
      endStdin();
      queueMicrotask(() => child.exit({ code: 0, signal: null }));
    };
    child.onSignal = (sig) => {
      if (sig === "SIGTERM" || sig === "SIGKILL") child.exit({ code: null, signal: sig });
    };
    queueMicrotask(() => emit(READY_FRAME));
  });
}

const READY_FRAME = recording("omp-plain")[0]!.frame;

function startTurn(host: ManualProcessHost, over: Partial<ProviderRunInput> = {}, options: OmpProviderOptions = {}) {
  const provider = new OmpProvider("omp", { killGraceMs: 20, interruptGraceMs: 200, closeGraceMs: 200, ...options });
  return provider.run({
    ctx: { cwd: WORKSPACE, env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-test" }, host },
    prompt: "go",
    ...ids,
    omp: FILES,
    ...over,
  });
}

/** Reads the whole stream; `onEvent` may act on the run as events arrive. */
async function drain(run: AgentRun, onEvent: (event: DomainEvent) => void = () => {}): Promise<DomainEvent[]> {
  const events: DomainEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    onEvent(event);
  }
  return events;
}

/** Waits until the fake's newest process has been sent a frame of `type`. */
async function eventuallyFrame(host: ManualProcessHost, type: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (host.children.at(-1)?.frames.some((f) => f.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never sent ${type}`);
}

const closing = (events: DomainEvent[]) => events.filter((e) => e.type === "agent.turn_completed" || e.type === "agent.turn_failed");

describe("OmpProvider", () => {
  describe("ask: one answer from omp -p", () => {
    const files = { overlayPath: "/c/omp/run/b.yml", guardHookPath: "/c/omp/agent/ucch-guard.ts" };
    const env = { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-test" };
    const isPrint = (argv: readonly string[]) => argv.includes("-p");

    it("runs with no tools and no session, on the smol role, the text on stdin", async () => {
      const host = new FakeProcessHost([
        { match: isPrint, lines: [{ stream: "stderr", line: "Working..." }, stdout("## Goal"), stdout("Fix it."), stdout("")] },
      ]);
      const answer = await new OmpProvider("omp").ask({ ctx: { cwd: WORKSPACE, env, host }, omp: files, prompt: "Write the brief.", stdin: "transcript" });
      expect(answer).toBe("## Goal\nFix it.");
      expect(host.spawned[0]).toMatchObject({ argv: ompPrintArgv({ bin: "omp", ...files, prompt: "Write the brief.", model: "@smol" }), stdin: "transcript" });
      expect(host.spawned[0]!.argv).toEqual(
        expect.arrayContaining(["-p", "--no-session", "--no-tools", "--no-extensions", "--no-rules", "--no-lsp", "--model", "@smol"]),
      );
      expect(host.spawned[0]!.argv.at(-1)).toBe("Write the brief.");
      // An OpenRouter model, as a turn names one.
      await new OmpProvider("omp").ask({ ctx: { cwd: WORKSPACE, env, host }, omp: files, prompt: "p", stdin: "", model: "openai/gpt-5-mini" });
      expect(host.spawned[1]!.argv).toEqual(expect.arrayContaining(["--model", "openrouter/openai/gpt-5-mini"]));
    });

    it("rejects with OMP's own error, not its progress line, and on an empty answer", async () => {
      const failing = new FakeProcessHost([
        { match: isPrint, lines: [{ stream: "stderr", line: "Working..." }, { stream: "stderr", line: "error: No API key found for openrouter." }], exit: { code: 1, signal: null } },
      ]);
      await expect(new OmpProvider("omp").ask({ ctx: { cwd: WORKSPACE, env, host: failing }, omp: files, prompt: "p", stdin: "" })).rejects.toThrow(
        /^error: No API key found for openrouter\.$/,
      );
      const silent = new FakeProcessHost([{ match: isPrint, lines: [{ stream: "stderr", line: "Working..." }] }]);
      await expect(new OmpProvider("omp").ask({ ctx: { cwd: WORKSPACE, env, host: silent }, omp: files, prompt: "p", stdin: "" })).rejects.toThrow(
        "omp answered with nothing",
      );
    });

    it("refuses a forbidden credential before spawning", async () => {
      const host = new FakeProcessHost([]);
      await expect(
        new OmpProvider("omp").ask({ ctx: { cwd: WORKSPACE, env: { ...env, OPENAI_API_KEY: "x" }, host }, omp: files, prompt: "p", stdin: "" }),
      ).rejects.toThrow(/OPENAI_API_KEY/);
      expect(host.spawned).toHaveLength(0);
    });
  });

  describe("maintain: compact and handoff between turns", () => {
    const AFTER = { ...STATS_AFTER, contextUsage: { tokens: 1500, contextWindow: 128000, percent: 1.2 } };
    const maintain = (host: ManualProcessHost, over: Partial<OmpMaintenanceInput> = {}) =>
      new OmpProvider("omp", { killGraceMs: 20, interruptGraceMs: 50, closeGraceMs: 200 }).maintain({
        ctx: { cwd: WORKSPACE, env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-test" }, host },
        threadId: ids.threadId,
        resumeToken: SESSION,
        model: "anthropic/claude-sonnet-4.5",
        omp: FILES,
        method: "compact",
        ...over,
      });

    it.each(["compact", "handoff"] as const)("%s: resumes the session, sends the focus, and returns the divider and the reading", async (method) => {
      const host = fakeOmp({ stats: [AFTER] });
      const events = await maintain(host, { method, focus: "the parser" });
      const [child] = host.children;
      expect(child!.spec.argv).toEqual(expect.arrayContaining(["--resume", SESSION, "--model", "openrouter/anthropic/claude-sonnet-4.5"]));
      expect(child!.frames.find((f) => f.type === method)).toMatchObject({ customInstructions: "the parser" });
      expect(events).toEqual([
        {
          type: "context.injected",
          threadId: ids.threadId,
          source: "compaction",
          content: `${method} summary: the parser`,
          compaction: { method: method === "handoff" ? "handoff" : "soft", tokensBefore: 9000, tokensAfter: 1500 },
        },
        { type: "context.usage", threadId: ids.threadId, usedTokens: 1500, windowTokens: 128000, thresholdTokens: null },
      ]);
      expect(child!.stdinOpen).toBe(false);
    });

    it("says why when OMP refuses, skips, or writes nothing", async () => {
      await expect(maintain(fakeOmp({ fold: { refuse: "Nothing to compact" } }))).rejects.toThrow("Nothing to compact");
      await expect(maintain(fakeOmp({ fold: { skipped: "Already compacted" } }))).rejects.toThrow("Already compacted");
      await expect(maintain(fakeOmp({ fold: { silent: true } }), { method: "handoff" })).rejects.toThrow(/wrote no summary/);
    });

    it("stops when asked: abort, then a kill if OMP does not wind down", async () => {
      const host = fakeOmp({ fold: { hang: true } });
      const controller = new AbortController();
      const pending = maintain(host, { signal: controller.signal });
      await eventuallyFrame(host, "compact");
      controller.abort();
      await expect(pending).rejects.toThrow("Stopped.");
      expect(host.children[0]!.frames.map((f) => f.type)).toContain("abort");
      expect(host.children[0]!.signals).toContain("SIGTERM");
    });

    it("refuses a forbidden credential before spawning", async () => {
      const host = fakeOmp();
      await expect(
        maintain(host, { ctx: { cwd: WORKSPACE, env: { OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "x" }, host } }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
      expect(host.children).toHaveLength(0);
    });
  });

  describe("the context meter's readings", () => {
    const at = (tokens: number, extra: object = {}): OmpSessionStats => ({
      ...STATS_AFTER,
      contextUsage: { tokens, contextWindow: 128000, percent: (tokens / 128000) * 100 },
      ...extra,
    });

    it("asks after each model call and once at the end, in order, before the turn closes", async () => {
      // omp-tool makes three model calls: three turn_end frames.
      const host = fakeOmp({ turn: promptFrames("omp-tool"), stats: [STATS_BEFORE, at(4000), at(9000), at(2500), at(2600)] });
      const events = await drain(startTurn(host));
      const asked = host.children[0]!.frames.filter((f) => f.type === "get_session_stats");
      expect(asked).toHaveLength(5);
      const readings = events.filter((e) => e.type === "context.usage");
      // Down after the third call: a compaction shrank it.
      expect(readings.map((e) => (e as { usedTokens: number }).usedTokens)).toEqual([4000, 9000, 2500, 2600]);
      expect(readings[0]).toEqual({
        type: "context.usage",
        threadId: ids.threadId,
        turnId: ids.turnId,
        usedTokens: 4000,
        windowTokens: 128000,
        thresholdTokens: null,
      });
      const closed = events.findIndex((e) => e.type === "agent.turn_completed");
      expect(events.findLastIndex((e) => e.type === "context.usage")).toBeLessThan(closed);
      expect(closed).toBe(events.length - 1);
      // The cost is still the session's totals after, less those before.
      expect(events[closed]).toMatchObject({ costUsd: expect.closeTo(0.004, 6) });
    });

    it("carries the overlay's threshold", async () => {
      const host = fakeOmp({ stats: [STATS_BEFORE, at(5000)] });
      const events = await drain(startTurn(host, { omp: { ...FILES, contextThreshold: { percent: 80 } } }));
      expect(events.filter((e) => e.type === "context.usage")).toEqual([
        expect.objectContaining({ usedTokens: 5000, windowTokens: 128000, thresholdTokens: 102400 }),
      ]);
    });

    it("sends nothing when the stats carry no size", async () => {
      const events = await drain(startTurn(fakeOmp()));
      expect(events.some((e) => e.type === "context.usage")).toBe(false);
      expect(events.at(-1)?.type).toBe("agent.turn_completed");
    });
  });

  describe("on a compaction mid-turn", () => {
    const SUMMARY = "Summary: the session so far.";
    const frames = (): OmpFrame[] => {
      const plain = promptFrames("omp-plain");
      const at = plain.findIndex((f) => f.type === "message_update");
      return [
        ...plain.slice(0, at),
        { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
        { type: "auto_compaction_end", action: "context-full", result: { summary: SUMMARY, tokensBefore: 142000 }, aborted: false, willRetry: false },
        ...plain.slice(at),
      ];
    };

    it("asks the session for the figures, and keeps what followed after the divider", async () => {
      const host = fakeOmp({
        turn: frames(),
        messages: [{ role: "compactionSummary", summary: SUMMARY, tokensBefore: 142000, tokensAfter: 31000, method: "handoff" }],
      });
      const events = await drain(startTurn(host));
      expect(host.children[0]!.frames.map((f) => f.type)).toContain("get_messages");
      const at = events.findIndex((e) => e.type === "context.injected");
      expect(events[at]).toEqual({
        type: "context.injected",
        threadId: ids.threadId,
        turnId: ids.turnId,
        source: "compaction",
        content: SUMMARY,
        compaction: { method: "handoff", tokensBefore: 142000, tokensAfter: 31000 },
      });
      // The prose streamed after the compaction is still after it.
      const firstText = events.findIndex((e) => e.type === "agent.text_delta");
      expect(firstText).toBeGreaterThan(at);
      expect(events.at(-1)?.type).toBe("agent.turn_completed");
    });

    it("sends the divider without them when the session cannot say", async () => {
      const events = await drain(startTurn(fakeOmp({ turn: frames(), messages: false })));
      expect(events.find((e) => e.type === "context.injected")).toMatchObject({ compaction: { tokensBefore: 142000 } });
      expect(events.at(-1)?.type).toBe("agent.turn_completed");
    });
  });

  it("runs a turn: session, prompt, stream, usage, then stdin closed", async () => {
    const host = fakeOmp();
    const events = await drain(startTurn(host));
    const [child] = host.children;
    expect(child!.frames.map((f) => f.type)).toEqual([
      "negotiate_protocol",
      "set_subagent_subscription",
      "get_state",
      "get_session_stats",
      "prompt",
      // The context's size after the model call (its `turn_end`), then the turn's totals.
      "get_session_stats",
      "get_session_stats",
    ]);
    expect(child!.frames[4]).toMatchObject({ type: "prompt", message: "go" });
    expect(child!.stdinOpen).toBe(false);
    expect(child!.signals).toEqual([]);
    expect(events[0]).toEqual({ type: "agent.session_started", ...pick(ids), provider: "omp", sessionId: SESSION });
    expect(closing(events)).toEqual([
      {
        type: "agent.turn_completed",
        ...pick(ids),
        stopReason: "end_turn",
        usage: { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 20, cacheCreationInputTokens: 0 },
        costUsd: expect.closeTo(0.004, 10),
      },
    ]);
    expect(events.at(-1)?.type).toBe("agent.turn_completed");
  });

  it("spawns ompArgv with the run's files, the OpenRouter model and the knowledge as text", async () => {
    const host = fakeOmp();
    await drain(
      startTurn(host, { model: "anthropic/claude-sonnet-4.5", effort: "high", permissionMode: "strict", instructions: "Rules", resumeToken: SESSION }),
    );
    const { argv, cwd, env } = host.children[0]!.spec;
    expect(argv).toEqual(
      ompArgv({
        bin: "omp",
        ...FILES,
        model: "openrouter/anthropic/claude-sonnet-4.5",
        effort: "high",
        permissionMode: "strict",
        appendSystemPrompt: "Rules",
        resumeToken: SESSION,
      }),
    );
    expect(argv.at(argv.indexOf("--append-system-prompt") + 1)).toBe("Rules\n");
    expect(cwd).toBe(WORKSPACE);
    expect(env).toEqual({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-test" });
  });

  it("round-trips the confirm recording: requested, resolved, then the tool's result", async () => {
    const host = fakeOmp({ turn: promptFrames("omp-confirm") });
    const run = startTurn(host);
    const answers: boolean[] = [];
    const events = await drain(run, (event) => {
      if (event.type === "agent.permission_requested") {
        answers.push(run.answerPermission!(event.requestId, { behavior: answers.length === 0 ? "allow" : "deny" }));
      }
    });
    expect(answers).toEqual([true, true]);
    expect(run.answerPermission!("15bb4296eaba7a53", { behavior: "allow" })).toBe(false);
    const sent = host.children[0]!.frames.filter((f) => f.type === "extension_ui_response");
    expect(sent).toEqual([
      { type: "extension_ui_response", id: "15bb4296eaba7a53", value: "Approve" },
      { type: "extension_ui_response", id: "15bb4296f3ba7a54", value: "Deny" },
    ]);
    const order = events
      .filter((e) => ["agent.permission_requested", "agent.permission_resolved", "agent.tool_result"].includes(e.type))
      .map((e) => e.type.slice("agent.".length));
    expect(order).toEqual([
      "permission_requested",
      "permission_resolved",
      "tool_result",
      "permission_requested",
      "permission_resolved",
      "tool_result",
    ]);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "end_turn" })]);
  });

  it("ends an interrupted stream as cancelled, by abort and a clean exit", async () => {
    const host = fakeOmp({ turn: promptFrames("omp-plain"), stallAfter: 8 });
    const run = startTurn(host);
    const events = await drain(run, (event) => {
      if (event.type === "agent.text_delta") void run.interrupt();
    });
    const child = host.children[0]!;
    expect(child.frames.map((f) => f.type)).toContain("abort");
    expect(child.signals).toEqual([]);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
  });

  it("cancels an open approval before it aborts, which OMP needs to take the abort", async () => {
    const host = fakeOmp({ turn: promptFrames("omp-confirm") });
    const run = startTurn(host);
    const events = await drain(run, (event) => {
      if (event.type === "agent.permission_requested") void run.interrupt();
    });
    const sent = host.children[0]!.frames.map((f) => f.type + (f.type === "extension_ui_response" ? `:${String(f.cancelled)}` : ""));
    expect(sent.slice(sent.indexOf("prompt") + 1, sent.indexOf("abort") + 1)).toEqual(["extension_ui_response:true", "abort"]);
    expect(events.filter((e) => e.type === "agent.permission_resolved")).toEqual([
      expect.objectContaining({ requestId: "15bb4296eaba7a53", behavior: "deny" }),
    ]);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
    expect(host.children[0]!.signals).toEqual([]);
  });

  it("kills a turn that ignores the abort, and still closes it", async () => {
    const host = fakeOmp({ stallAfter: 8, deaf: true });
    const run = startTurn(host);
    const events = await drain(run, (event) => {
      if (event.type === "agent.text_delta") void run.interrupt();
    });
    expect(host.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
  });

  it("stops before the prompt when interrupted while starting", async () => {
    const host = fakeOmp();
    const run = startTurn(host);
    void run.interrupt();
    const events = await drain(run);
    expect(host.children[0]!.frames.map((f) => f.type)).not.toContain("prompt");
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
  });

  it("kill() ends a running turn at once", async () => {
    const host = fakeOmp({ stallAfter: 8 });
    const run = startTurn(host);
    const events = await drain(run, (event) => {
      if (event.type === "agent.text_delta") void run.kill();
    });
    expect(host.children[0]!.signals[0]).toBe("SIGTERM");
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
  });

  it.each(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "COPILOT_GITHUB_TOKEN"])("refuses to start with %s before spawning", (name) => {
    const host = fakeOmp();
    expect(() => startTurn(host, { ctx: { cwd: WORKSPACE, env: { OPENROUTER_API_KEY: "k", [name]: "x" }, host } })).toThrow(name);
    expect(host.children).toHaveLength(0);
  });

  it("refuses to start without the run's files", () => {
    const host = fakeOmp();
    expect(() => startTurn(host, { omp: undefined })).toThrow(/overlay/);
    expect(host.children).toHaveLength(0);
  });

  it("fails the turn with OMP's reason when it exits before ready", async () => {
    const host = new ManualProcessHost((child) => {
      queueMicrotask(() => {
        child.emit('Session "nope" not found', "stderr");
        child.exit({ code: 1, signal: null });
      });
    });
    const events = await drain(startTurn(host, { resumeToken: "nope" }));
    expect(events).toEqual([{ type: "agent.turn_failed", ...pick(ids), error: expect.stringContaining('Session "nope" not found') }]);
  });

  it("fails the turn when OMP refuses the prompt, and closes it", async () => {
    const host = fakeOmp({ refusePrompt: "Agent is busy" });
    const events = await drain(startTurn(host));
    expect(closing(events)).toEqual([{ type: "agent.turn_failed", ...pick(ids), error: "Agent is busy" }]);
    expect(host.children[0]!.stdinOpen).toBe(false);
  });

  it("fails the turn when the process dies mid-stream", async () => {
    const host = fakeOmp({ stallAfter: 8 });
    let crashed = false;
    const events = await drain(startTurn(host), (event) => {
      if (event.type === "agent.text_delta" && !crashed) {
        crashed = true;
        host.children[0]!.emit("Segmentation fault", "stderr");
        host.children[0]!.exit({ code: 139, signal: null });
      }
    });
    expect(closing(events)).toEqual([{ type: "agent.turn_failed", ...pick(ids), error: "Segmentation fault" }]);
  });

  it("fails the turn and kills OMP on a frame that cannot be put back together", async () => {
    const host = fakeOmp({
      turn: [{ type: "rpc_chunk", chunkId: "c1", index: 0, count: 2, byteLength: 10, data: "!!not base64!!" }],
    });
    const events = await drain(startTurn(host));
    expect(host.children[0]!.signals).toEqual(["SIGTERM"]);
    expect(closing(events)).toEqual([
      { type: "agent.turn_failed", ...pick(ids), error: expect.stringMatching(/^omp sent a frame that could not be read/) },
    ]);
  });
});

describe("OmpProvider host tools", () => {
  const ECHO = {
    name: "ucch_echo",
    label: "Echo",
    description: "Echo text back from the host.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };
  /** The recorded call's id in omp-host-tool-xd. */
  const CALL = "15bb4c8a9cfd4836";

  it("registers them, runs a call through the runner, and answers it; OMP's own rows are the events", async () => {
    const host = fakeOmp({ turn: promptFrames("omp-host-tool-xd") });
    const calls: unknown[] = [];
    const events = await drain(
      startTurn(host, {
        hostTools: [ECHO],
        onHostToolCall: async (call) => {
          calls.push(call);
          return { content: `echo: ${String(call.arguments.text)}`, isError: false };
        },
      }),
    );
    const frames = host.children[0]!.frames;
    expect(frames.map((f) => f.type).slice(0, 3)).toEqual(["negotiate_protocol", "set_subagent_subscription", "set_host_tools"]);
    expect(frames[2]).toMatchObject({ tools: [ECHO] });
    expect(calls).toEqual([{ id: CALL, toolCallId: "call_1", toolName: "ucch_echo", arguments: { text: "ping" } }]);
    expect(frames.filter((f) => f.type === "host_tool_result")).toEqual([
      { type: "host_tool_result", id: CALL, result: { content: [{ type: "text", text: "echo: ping" }] } },
    ]);
    const uses = events.filter((e) => e.type === "agent.tool_use");
    expect(uses).toEqual([expect.objectContaining({ toolUseId: "call_1", name: "ucch_echo", input: { text: "ping" } })]);
    expect(events.filter((e) => e.type === "agent.tool_result")).toHaveLength(1);
    expect(events.some((e) => e.type === "file.changed")).toBe(false);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed" })]);
  });

  it("answers a failed call, and one whose runner throws, with isError", async () => {
    for (const runner of [
      async () => ({ content: "ucch_echo failed: boom", isError: true }),
      async () => {
        throw new Error("boom");
      },
    ]) {
      const host = fakeOmp({ turn: promptFrames("omp-host-tool-xd") });
      await drain(startTurn(host, { hostTools: [ECHO], onHostToolCall: runner }));
      expect(host.children[0]!.frames.filter((f) => f.type === "host_tool_result")).toEqual([
        { type: "host_tool_result", id: CALL, isError: true, result: { content: [{ type: "text", text: "ucch_echo failed: boom" }] } },
      ]);
    }
  });

  it("aborts a running call when OMP cancels it on the stop button", async () => {
    const host = fakeOmp({ turn: promptFrames("omp-host-tool-xd") });
    let aborted = false;
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const run = startTurn(host, {
      hostTools: [ECHO],
      onHostToolCall: (_call, signal) =>
        new Promise((resolve) => {
          started();
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ content: "ucch_echo was cancelled.", isError: true });
          });
        }),
    });
    void running.then(() => run.interrupt());
    const events = await drain(run);
    expect(aborted).toBe(true);
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_completed", stopReason: "cancelled" })]);
  });

  it("offers none when the turn has none", async () => {
    const host = fakeOmp();
    await drain(startTurn(host, { hostTools: [] }));
    expect(host.children[0]!.frames.map((f) => f.type)).not.toContain("set_host_tools");
  });

  it("fails the turn when OMP will not register them", async () => {
    const host = fakeOmp({ refuseHostTools: "bad schema" });
    const events = await drain(startTurn(host, { hostTools: [ECHO], onHostToolCall: async () => ({ content: "", isError: false }) }));
    expect(host.children[0]!.frames.map((f) => f.type)).not.toContain("prompt");
    expect(closing(events)).toEqual([expect.objectContaining({ type: "agent.turn_failed", error: "omp refused the host tools: bad schema" })]);
  });
});

describe("probeOmp", () => {
  const version = (stdout: string, code = 0) => new FakeProcessHost([{ match: (argv) => argv[1] === "--version", lines: [{ stream: "stdout", line: stdout }], exit: { code, signal: null } }]);

  it("reports the version, and the OpenRouter key as how it bills", async () => {
    expect(await probeOmp({ cwd: "/", env: { OPENROUTER_API_KEY: "k" }, host: version("omp/18.14.1") }, "omp")).toEqual({
      installed: true,
      version: "18.14.1",
      authenticated: true,
      authMode: "api-key",
      account: "OpenRouter key",
    });
  });

  it("is not authenticated without a key", async () => {
    expect(await probeOmp({ cwd: "/", env: {}, host: version("omp/18.14.1") }, "omp")).toMatchObject({ installed: true, authenticated: false, authMode: "none" });
  });

  it("is not installed when omp does not run", async () => {
    expect(await probeOmp({ cwd: "/", env: {}, host: new FakeProcessHost([]) }, "omp")).toMatchObject({ installed: false, authenticated: false });
  });

  it("warns about a credential that would refuse every run", async () => {
    const health = await probeOmp({ cwd: "/", env: { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "x" }, host: version("omp/18.14.1") }, "omp");
    expect(health.warnings).toEqual([expect.stringContaining("OPENAI_API_KEY")]);
  });
});

describe("ompModel", () => {
  it("names an OpenRouter id as OMP does, once", () => {
    expect(ompModel("anthropic/claude-sonnet-4.5")).toBe("openrouter/anthropic/claude-sonnet-4.5");
    expect(ompModel("openrouter/anthropic/claude-sonnet-4.5")).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });
});
