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
 *
 * What it answers, as 18.14.1 does on the wire (spike report, OM0.3):
 *   --version         `omp/18.14.1`
 *   --mode rpc-ui     `ready`, then commands by `id`:
 *     negotiate_protocol  v2 when asked (it never sends a frame big enough
 *                         to need chunking)
 *     get_state           the session id
 *     get_session_stats   fixed numbers per completed turn, cumulative over
 *                         the session, as OMP's totals are
 *     prompt              the recording's first prompt, from just after its
 *                         response to its `prompt_result`. A dialog
 *                         (`extension_ui_request` select/confirm/input/
 *                         editor) holds the stream until it is answered;
 *                         the recording carries on as recorded whatever the
 *                         answer.
 *     abort               ends the turn as OMP does: an aborted message,
 *                         the terminal `agent_end`, `prompt_result` aborted.
 *                         Held while a dialog is open, as OMP holds it.
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

const OWN = new Set(["--rate", "--chunk", "--length", "--rss-mb", "--fixture"]);
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
if (resume) {
  const names = sessionDir && existsSync(sessionDir) ? readdirSync(sessionDir) : [];
  const matches = names.filter((name) => SESSION_FILE.exec(name)?.[1].startsWith(resume));
  if (matches.length !== 1) {
    process.stderr.write(`Error: Session "${resume}" not found.\n`);
    process.exit(1);
  }
  sessionId = SESSION_FILE.exec(matches[0])[1];
  sessionFile = join(sessionDir, matches[0]);
  turnsBefore = readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && JSON.parse(line).type === "turn_end").length;
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
      tokens: input + output,
      contextWindow: CONTEXT_WINDOW,
      percent: Math.round(((input + output) / CONTEXT_WINDOW) * 10_000) / 100,
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
const promptAt = recorded.findIndex((frame) => frame.type === "response" && frame.command === "prompt");
const resultAt = recorded.findIndex((frame, i) => i > promptAt && frame.type === "prompt_result");
if (promptAt < 0 || resultAt < 0) {
  process.stderr.write(`fake-omp: ${fixture} has no prompt to replay\n`);
  process.exit(2);
}
const turnFrames = recorded.slice(promptAt + 1, resultAt + 1).filter((frame) => frame.type !== "response");
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

async function play(prompt) {
  const turn = { aborted: false, dialog: null, answered: () => {} };
  current = turn;
  record({ type: "user", text: typeof prompt.message === "string" ? prompt.message : "" });
  let streamed = false;
  let result = null;
  for (const frame of turnFrames) {
    if (turn.aborted || stdinClosed) break;
    if (frame.type === "prompt_result") {
      result = frame;
      break;
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
    out(withAnswer(frame));
    if (frame.type === "extension_ui_request" && DIALOGS.has(frame.method)) {
      turn.dialog = frame.id;
      await new Promise((resolve) => (turn.answered = resolve));
      turn.dialog = null;
    }
  }
  if (turn.aborted) {
    out({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Interrupted by user" },
    });
    out({ type: "agent_end", messages: [], isTerminal: true });
    out({ type: "prompt_result", id: prompt.id, agentInvoked: true, status: "aborted", sessionSettled: true });
  } else if (!stdinClosed) {
    turnsHere++;
    record({ type: "turn_end" });
    out({ ...result, id: prompt.id });
    out({ type: "session_settled" });
  }
  current = null;
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
      // A dialog holds the abort: the turn sees it once the dialog is answered.
      if (current) current.aborted = true;
      return;
    case "extension_ui_response":
      if (current && frame.id === current.dialog) current.answered();
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
  current?.answered();
  while (current) await sleep(5);
  if (held) held[0] = 0;
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(143));

out(READY);
