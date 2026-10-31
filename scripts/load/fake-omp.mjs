#!/usr/bin/env node
/**
 * A stand-in for `omp` (oh-my-pi), for tests and load tests: it speaks OMP's
 * RPC protocol (`--mode rpc` / `rpc-ui`) and plays a recorded turn, without
 * an OpenRouter key or the network.
 *
 *   OMP_BIN=/path/to/fake-omp.mjs
 *
 * Its own options come before or among OMP's, or from the environment
 * (OMP_BIN is a path, not a command line -- or wrap it in a two-line script
 * that passes them):
 *
 *   --fixture F  the RPC recording to replay  FAKE_OMP_FIXTURE
 *                (fixtures/omp-plain.jsonl, from packages/providers)
 *   --length N   tokens in the answer         FAKE_OMP_LENGTH  (absent: the
 *                recording's own text, sent at once)
 *   --rate N     tokens a second, with --length  FAKE_OMP_RATE  (60)
 *   --chunk N    tokens per text delta        FAKE_OMP_CHUNK   (1)
 *   --rss-mb N   memory to allocate and hold  FAKE_OMP_RSS_MB  (0), as the
 *                real process holds ~270-320 MB (spike report, OM0.6)
 *   --prompt N   which of the recording's prompts to replay, from 1
 *                                             FAKE_OMP_PROMPT  (1); the
 *                second and fourth of omp-compaction.jsonl compact mid-turn
 *
 * What it answers, as 18.14.1 does on the wire (spike report, OM0.3):
 *   --version         `omp/18.14.1`
 *   -p                a brief, in markdown, from what stdin carried and the
 *                     prompt's "Focus on:" line; "Working..." on stderr.
 *                     FAKE_OMP_PRINT_LOG=F appends {argv, stdin, prompt} to
 *                     F; FAKE_OMP_PRINT_FAIL=msg exits 1 with it instead
 *   --mode rpc-ui     `ready`, then commands by `id`:
 *     negotiate_protocol  v2 when asked (it never sends a frame big enough
 *                         to need chunking)
 *     get_state           the session id
 *     get_session_stats   fixed numbers per completed turn, cumulative over
 *                         the session, as OMP's totals are. Its context
 *                         size grows with each model call (`turn_end`) of
 *                         the turn, to the turn's tokens by its end, and a
 *                         compaction (`auto_compaction_end`) cuts it to a
 *                         quarter, so a meter can be seen to move and drop
 *     get_messages        the recording's own answer to it, if it has one,
 *                         and a `compactionSummary` for each compact or
 *                         handoff since
 *     compact             between turns, as 18.14.1 does (spike report,
 *                         Q4): `manual_compaction_start` / `_end`, the
 *                         result as the answer, a summary in the messages,
 *                         and the context cut to a quarter. Nothing in the
 *                         context: refused
 *     handoff             likewise, answered `{}`, its summary's method
 *                         `handoff`; `customInstructions` lands in both
 *     prompt              the recording's chosen prompt, from just after its
 *                         response to its `prompt_result`. A dialog
 *                         (`extension_ui_request` select/confirm/input/
 *                         editor) holds the stream until it is answered;
 *                         the recording carries on as recorded whatever the
 *                         answer.
 *                         A `host_tool_call` holds it likewise until its
 *                         `host_tool_result`, whose text and `isError`
 *                         then stand in for the recorded result of that
 *                         call, as OMP reports the host's answer.
 *     abort               ends the turn as OMP does: an aborted message,
 *                         the terminal `agent_end`, `prompt_result` aborted.
 *                         Held while a dialog is open, as OMP holds it; a
 *                         host call still running gets `host_tool_cancel`.
 *     anything else       success, with empty data
 *   --session-dir D   sessions persist as `D/<timestamp>_<id>.jsonl`, so a
 *                     later `--resume <id>` (or a unique prefix) continues
 *                     one; an unknown id exits 1 before `ready` with OMP's
 *                     `Session "<id>" not found.`
 *   stdin closed      exits 0.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const OWN = new Set(["--rate", "--chunk", "--length", "--rss-mb", "--fixture", "--prompt"]);
const argv = process.argv.slice(2);
const own = {};
const cli = [];
for (let i = 0; i < argv.length; i++) {
  if (OWN.has(argv[i])) own[argv[i].slice(2)] = argv[++i];
  else cli.push(argv[i]);
}
const option = (name, env, fallback) => {
  const raw = own[name] ?? process.env[env];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const flag = (name) => {
  const at = cli.indexOf(name);
  return at >= 0 ? cli[at + 1] : undefined;
};
const rate = Math.max(1, option("rate", "FAKE_OMP_RATE", 60));
const chunk = Math.max(1, Math.round(option("chunk", "FAKE_OMP_CHUNK", 1)));
const lengthOption = option("length", "FAKE_OMP_LENGTH", null);
const length = lengthOption === null ? null : Math.max(1, Math.round(lengthOption));
const rssMb = option("rss-mb", "FAKE_OMP_RSS_MB", 0);
const fixture =
  own.fixture || process.env.FAKE_OMP_FIXTURE || join(dirname(fileURLToPath(import.meta.url)), "fixtures", "omp-plain.jsonl");

const out = (frame) => process.stdout.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);

if (cli.includes("--version")) {
  out("omp/18.14.1");
  process.exit(0);
}

// `-p`: one answer and exit, as 18.14.1's text mode does -- "Working..." on
// stderr, the answer alone on stdout, stdin read ahead of the prompt.
if (cli.includes("-p") || cli.includes("--print")) {
  const VALUED = new Set(["--config", "--hook", "--model", "--mode", "--session-dir", "--approval-mode", "--thinking", "--max-time", "--resume"]);
  let prompt = "";
  for (let i = 0; i < cli.length; i++) {
    if (VALUED.has(cli[i])) i++;
    else if (!cli[i].startsWith("-")) prompt = cli[i];
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const piece of process.stdin) input += piece;
  process.stderr.write("Working...\n");
  if (process.env.FAKE_OMP_PRINT_LOG) {
    appendFileSync(process.env.FAKE_OMP_PRINT_LOG, `${JSON.stringify({ argv: cli, stdin: input, prompt })}\n`);
  }
  if (process.env.FAKE_OMP_PRINT_FAIL) {
    process.stderr.write(`error: ${process.env.FAKE_OMP_PRINT_FAIL}\n`);
    process.exit(1);
  }
  const focus = /\nFocus on: (.+)$/s.exec(prompt)?.[1]?.trim();
  const asked = /## User\n(.+)/.exec(input)?.[1]?.trim();
  out(
    [
      "## Goal",
      asked ?? "Carry on the work.",
      "## Done",
      `Read ${input.length} characters of transcript.`,
      "## Next",
      focus ?? "The next step.",
    ].join("\n"),
  );
  process.exit(0);
}
const mode = flag("--mode");
if (mode !== "rpc" && mode !== "rpc-ui") {
  process.stderr.write(`fake-omp: nothing to do for: ${cli.join(" ")}\n`);
  process.exit(2);
}

// The real binary names itself, and the resource sampler counts processes by name.
process.title = "omp";

// Filled, not just allocated: an untouched allocation is never resident.
const held = rssMb > 0 ? Buffer.alloc(rssMb * 1024 * 1024, 1) : null;

// -- The session ----------------------------------------------------------------

const SESSION_FILE = /^[^_]+_(.+)\.jsonl$/;
const sessionDir = flag("--session-dir");
const resume = flag("--resume");
let sessionId;
let sessionFile = null;
let turnsBefore = 0;
/** The context's size the resumed session ended on, if it recorded one. */
let resumedContext = null;
if (resume) {
  const names = sessionDir && existsSync(sessionDir) ? readdirSync(sessionDir) : [];
  const matches = names.filter((name) => SESSION_FILE.exec(name)?.[1].startsWith(resume));
  if (matches.length !== 1) {
    process.stderr.write(`Error: Session "${resume}" not found.\n`);
    process.exit(1);
  }
  sessionId = SESSION_FILE.exec(matches[0])[1];
  sessionFile = join(sessionDir, matches[0]);
  const entries = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  turnsBefore = entries.filter((entry) => entry.type === "turn_end").length;
  resumedContext = entries.findLast((entry) => entry.type === "context")?.tokens ?? null;
} else {
  sessionId = randomUUID();
  if (sessionDir) sessionFile = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}
let turnsHere = 0;

/** Appends to the session file, which a `--resume` reads back. Nothing without `--session-dir`. */
const record = (entry) => {
  if (!sessionFile) return;
  mkdirSync(dirname(sessionFile), { recursive: true });
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
};

/** What one completed turn adds to the session's totals. */
const PER_TURN = { input: 1200, output: length ?? 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012 };
const CONTEXT_WINDOW = 200_000;
/** Tokens in the context now: see `get_session_stats` above. */
let contextTokens = resumedContext ?? turnsBefore * (PER_TURN.input + PER_TURN.output);

function stats() {
  const turns = turnsBefore + turnsHere;
  const input = turns * PER_TURN.input;
  const output = turns * PER_TURN.output;
  return {
    sessionFile,
    sessionId,
    userMessages: turns,
    assistantMessages: turns,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: turns * 2,
    tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + output },
    cost: Math.round(turns * PER_TURN.cost * 1e6) / 1e6,
    contextUsage: {
      tokens: contextTokens,
      contextWindow: CONTEXT_WINDOW,
      percent: Math.round((contextTokens / CONTEXT_WINDOW) * 10_000) / 100,
    },
  };
}

// -- The recording ---------------------------------------------------------------

const recorded = readFileSync(fixture, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.dir === "out")
  .map((entry) => entry.frame);
const promptNumber = Math.max(1, Math.round(option("prompt", "FAKE_OMP_PROMPT", 1)));
const promptAt = recorded.findIndex(
  (frame, i) =>
    frame.type === "response" &&
    frame.command === "prompt" &&
    recorded.slice(0, i + 1).filter((f) => f.type === "response" && f.command === "prompt").length === promptNumber,
);
const recordedMessages = recorded.find((frame) => frame.type === "response" && frame.command === "get_messages")?.data ?? {
  messages: [],
};
const resultAt = recorded.findIndex((frame, i) => i > promptAt && frame.type === "prompt_result");
if (promptAt < 0 || resultAt < 0) {
  process.stderr.write(`fake-omp: ${fixture} has no prompt to replay\n`);
  process.exit(2);
}
// A turn with a background task (omp-subagent.jsonl) goes on past its
// `prompt_result`: the first `agent_end` is not terminal, and the task's
// frames, its result and the answer to it follow, to the terminal one.
const nextPromptAt = recorded.findIndex((frame, i) => i > resultAt && frame.type === "response" && frame.command === "prompt");
const backgrounded = recorded
  .slice(promptAt + 1, resultAt)
  .some((frame) => frame.type === "agent_end" && frame.isTerminal === false);
const terminalAt = backgrounded
  ? recorded.findIndex(
      (frame, i) => i > resultAt && (nextPromptAt < 0 || i < nextPromptAt) && frame.type === "agent_end" && frame.isTerminal !== false,
    )
  : -1;
const turnFrames = recorded
  .slice(promptAt + 1, (terminalAt > resultAt ? terminalAt : resultAt) + 1)
  .filter((frame) => frame.type !== "response");
/** What one model call adds to the context: the turn's tokens over its calls. */
const PER_CALL = (PER_TURN.input + PER_TURN.output) / Math.max(1, turnFrames.filter((frame) => frame.type === "turn_end").length);
const READY = recorded.find((frame) => frame.type === "ready") ?? {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
};

const WORDS = "a stand in for oh my pi streaming one token after another so the harness has something to render".split(" ");
const textOf = (from, n) => {
  let text = "";
  for (let i = from; i < from + n; i++) text += (i > 0 && i % 80 === 0 ? "\n\n" : i > 0 ? " " : "") + WORDS[i % WORDS.length];
  return text;
};
const answer = length === null ? null : textOf(0, length);

// -- The turn ---------------------------------------------------------------------

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The turn in flight: whether it was aborted, and the dialog it waits on. */
let current = null;
let stdinClosed = false;

async function streamText(turn, contentIndex) {
  const interval = (1000 * chunk) / rate;
  const started = performance.now();
  for (let sent = 0; sent < length && !turn.aborted && !stdinClosed; ) {
    const n = Math.min(chunk, length - sent);
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta: textOf(sent, n) } });
    sent += n;
    const wait = started + (sent / chunk) * interval - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

/** With `--length`, an assistant message's text is the generated answer. */
function withAnswer(frame) {
  if (answer === null || frame.type !== "message_end" || frame.message?.role !== "assistant") return frame;
  const content = frame.message.content.map((block) => (block.type === "text" ? { ...block, text: answer } : block));
  return { ...frame, message: { ...frame.message, content } };
}

/** A recorded result of a host call, as the host actually answered it. */
function withHostResult(turn, frame) {
  const answer = turn.results.get(frame.toolCallId ?? frame.message?.toolCallId);
  if (!answer) return frame;
  const content = answer.result?.content ?? [];
  const isError = answer.isError === true;
  if (frame.type === "tool_execution_end") return { ...frame, result: { ...frame.result, content }, isError };
  if ((frame.type === "message_start" || frame.type === "message_end") && frame.message?.role === "toolResult") {
    return { ...frame, message: { ...frame.message, content, isError } };
  }
  return frame;
}

async function play(prompt) {
  const turn = { aborted: false, dialog: null, host: null, answered: () => {}, results: new Map() };
  current = turn;
  record({ type: "user", text: typeof prompt.message === "string" ? prompt.message : "" });
  let streamed = false;
  let result = null;
  let resultSent = false;
  for (const frame of turnFrames) {
    if (turn.aborted || stdinClosed) break;
    if (frame.type === "prompt_result") {
      result = frame;
      if (frame === turnFrames.at(-1)) break;
      // A background task still runs: the prompt is answered, the turn is not over.
      out({ ...frame, id: prompt.id });
      resultSent = true;
      continue;
    }
    const event = frame.type === "message_update" ? frame.assistantMessageEvent : null;
    if (answer !== null && event?.type === "text_delta") {
      // The recording's own deltas are replaced, all at once, by ours.
      if (!streamed) {
        streamed = true;
        await streamText(turn, event.contentIndex);
      }
      continue;
    }
    // Before the frame: whoever hears it and asks for stats sees the change.
    if (frame.type === "turn_end") contextTokens = Math.round(contextTokens + PER_CALL);
    if (frame.type === "auto_compaction_end" && frame.result && !frame.aborted) contextTokens = Math.round(contextTokens / 4);
    out(withHostResult(turn, withAnswer(frame)));
    // The next model call takes time, as a real one does: what the host
    // asked after this one (its stats) is answered before what follows.
    if (frame.type === "turn_end") await sleep(10);
    if (frame.type === "extension_ui_request" && DIALOGS.has(frame.method)) {
      turn.dialog = frame.id;
      await new Promise((resolve) => (turn.answered = resolve));
      turn.dialog = null;
    }
    if (frame.type === "host_tool_call") {
      turn.host = frame;
      const result = await new Promise((resolve) => (turn.answered = resolve));
      turn.host = null;
      if (result) turn.results.set(frame.toolCallId, result);
      else if (turn.aborted) out({ type: "host_tool_cancel", id: randomUUID(), targetId: frame.id });
    }
  }
  if (turn.aborted) {
    out({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Interrupted by user" },
    });
    out({ type: "agent_end", messages: [], isTerminal: true });
    if (!resultSent) out({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "aborted", sessionSettled: true });
  } else if (!stdinClosed) {
    turnsHere++;
    record({ type: "turn_end" });
    record({ type: "context", tokens: contextTokens });
    if (!resultSent) out({ ...result, id: prompt.id });
    out({ type: "session_settled" });
  }
  current = null;
}

/** The session's messages as `get_messages` lists them. */
const messages = [...(recordedMessages.messages ?? [])];

/** `compact` / `handoff` on the session, between turns. */
function fold(frame) {
  if (current) return respond(frame, undefined, { success: false, error: "Agent is already processing" });
  if (contextTokens === 0) return respond(frame, undefined, { success: false, error: "Nothing to compact" });
  const focus = typeof frame.customInstructions === "string" && frame.customInstructions ? frame.customInstructions : null;
  const tokensBefore = contextTokens;
  contextTokens = Math.round(contextTokens / 4);
  record({ type: "context", tokens: contextTokens });
  const handoff = frame.type === "handoff";
  const summary = handoff
    ? `## Goal\nCarry on the work.\n## Next\n${focus ?? "The next step."}`
    : `Summary: the session so far.${focus ? ` Kept: ${focus}.` : ""}`;
  messages.push({ role: "compactionSummary", summary, tokensBefore, tokensAfter: contextTokens, method: handoff ? "handoff" : "soft", timestamp: Date.now() });
  if (handoff) return respond(frame, {});
  const result = { summary, shortSummary: summary, firstKeptEntryId: randomUUID().slice(0, 8), tokensBefore, details: { readFiles: [], modifiedFiles: [] } };
  out({ type: "manual_compaction_start", reason: "manual" });
  out({ type: "manual_compaction_end", result, aborted: false, willRetry: false });
  return respond(frame, result);
}

function respond(frame, data, extra = {}) {
  out({ id: frame.id, type: "response", command: frame.type, success: true, ...(data === undefined ? {} : { data }), ...extra });
}

function handle(frame) {
  switch (frame.type) {
    case "negotiate_protocol":
      return respond(frame, { protocolVersion: frame.protocolVersion === 2 ? 2 : 1 });
    case "get_state":
      return respond(frame, {
        sessionId,
        sessionFile,
        isStreaming: current !== null,
        messageCount: (turnsBefore + turnsHere) * 2,
      });
    case "get_session_stats":
      return respond(frame, stats());
    case "get_messages":
      return respond(frame, { ...recordedMessages, messages });
    case "compact":
    case "handoff":
      return fold(frame);
    case "prompt":
      if (current) return respond(frame, undefined, { success: false, error: "Agent is already processing" });
      respond(frame);
      void play(frame).catch((error) => {
        process.stderr.write(`fake-omp: ${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      });
      return;
    case "abort":
      respond(frame);
      // A dialog holds the abort: the turn sees it once the dialog is
      // answered. A host call does not: OMP cancels it and moves on.
      if (current) {
        current.aborted = true;
        if (current.host) current.answered(null);
      }
      return;
    case "extension_ui_response":
      if (current && frame.id === current.dialog) current.answered();
      return;
    case "host_tool_result":
      if (current?.host && frame.id === current.host.id) current.answered(frame);
      return;
    default:
      if (typeof frame.id === "string") respond(frame, {});
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    out({ type: "response", command: "parse", success: false, error: String(error) });
    return;
  }
  handle(frame);
});
input.on("close", async () => {
  // OMP disposes the session and exits 0. A turn waiting on a dialog is not
  // waited for: nobody is left to answer it.
  stdinClosed = true;
  current?.answered(null);
  while (current) await sleep(5);
  if (held) held[0] = 0;
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(143));

out(READY);
