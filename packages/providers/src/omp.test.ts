import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DomainEvent } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import {
  approvalFor,
  editOperations,
  OmpNormaliser,
  OmpProvider,
  ompArgv,
  ompModel,
  probeOmp,
  thinkingFor,
  type OmpProviderOptions,
  type OmpSessionStats,
} from "./omp.js";
import type { OmpFrame } from "./omp-rpc-types.js";
import { FakeProcessHost, ManualProcessHost } from "./testing.js";
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
 * an `abort` that is held while a dialog is open (OM2.4), and an exit when
 * stdin closes.
 */
function fakeOmp(options: FakeOptions = {}) {
  let stats = 0;
  return new ManualProcessHost((child) => {
    const emit = (frame: object) => child.emit(JSON.stringify(frame));
    const respond = (frame: Record<string, unknown>, data?: unknown, extra: object = {}) =>
      emit({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }), ...extra });
    let queue: OmpFrame[] = [];
    let waitingOn: string | null = null;
    let heldAbort: Record<string, unknown> | null = null;
    let aborted = false;
    const pump = () => {
      while (queue.length && !waitingOn) {
        const frame = queue.shift()!;
        emit(frame);
        if (frame.type === "extension_ui_request" && frame.method === "select") waitingOn = String(frame.id);
      }
    };
    const abort = (frame: Record<string, unknown>) => {
      respond(frame);
      if (aborted) return;
      aborted = true;
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
          return respond(frame, stats++ === 0 ? STATS_BEFORE : STATS_AFTER);
        case "prompt":
          if (options.refusePrompt) return respond(frame, undefined, { success: false, error: options.refusePrompt });
          respond(frame);
          queue = [...(options.turn ?? promptFrames("omp-plain"))];
          if (options.stallAfter !== undefined) queue = queue.slice(0, options.stallAfter);
          return pump();
        case "abort":
          if (options.deaf) return;
          if (waitingOn) heldAbort = frame;
          else abort(frame);
          return;
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

const closing = (events: DomainEvent[]) => events.filter((e) => e.type === "agent.turn_completed" || e.type === "agent.turn_failed");

describe("OmpProvider", () => {
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
