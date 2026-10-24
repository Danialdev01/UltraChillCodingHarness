#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI, for load tests: it answers the harness's
 * probes and plays a turn in Claude Code's stream-json, at a rate you
 * choose, without a subscription or the network.
 *
 *   CLAUDE_BIN=/path/to/fake-claude.mjs
 *
 * Its own options come before or among the CLI's, or from the environment
 * (handy because CLAUDE_BIN is a path, not a command line -- or wrap it in a
 * two-line script that passes them):
 *
 *   --rate N     tokens a second             FAKE_CLAUDE_RATE    (60)
 *   --chunk N    tokens per text delta       FAKE_CLAUDE_CHUNK   (1)
 *   --length N   tokens in the answer        FAKE_CLAUDE_LENGTH  (1500)
 *   --rss-mb N   memory to allocate and hold FAKE_CLAUDE_RSS_MB  (0), as the
 *                real CLI holds ~370 MB
 *   --fixture F  the stream to replay        FAKE_CLAUDE_FIXTURE
 *                (fixtures/claude-text.jsonl, from packages/providers)
 *
 * What it answers:
 *   --version             a version line
 *   -p --help             help text naming the flags the harness probes for
 *   auth status           a logged-in subscription, as JSON
 *   -p ... (stream-json)  reads the user line from stdin, then replays the
 *                         fixture with its text answer replaced by --length
 *                         tokens at --rate, and the result's usage to match.
 *                         After the result it waits for stdin to close, as
 *                         the real CLI does when the harness holds stdin.
 *   SIGINT                stops the answer and prints the aborted result the
 *                         real CLI prints for the stop button.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  const value = Number(own[name] ?? process.env[env]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const rate = Math.max(1, option("rate", "FAKE_CLAUDE_RATE", 60));
const chunk = Math.max(1, Math.round(option("chunk", "FAKE_CLAUDE_CHUNK", 1)));
const length = Math.max(1, Math.round(option("length", "FAKE_CLAUDE_LENGTH", 1500)));
const rssMb = option("rss-mb", "FAKE_CLAUDE_RSS_MB", 0);
const fixture =
  own.fixture ?? process.env.FAKE_CLAUDE_FIXTURE ?? join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-text.jsonl");

const out = (line) => process.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);

if (cli.includes("--version")) {
  out("2.1.270 (Claude Code)");
  process.exit(0);
}
if (cli.includes("--help")) {
  out(
    [
      "Usage: claude [options] [command] [prompt]",
      "  -p, --print                    Print response and exit",
      "  --output-format <format>       text, json or stream-json",
      "  --input-format <format>        text or stream-json",
      "  --include-partial-messages     Include partial message chunks",
      "  --permission-mode <mode>       Permission mode for the session",
      "  --permission-prompt-tool <t>   Tool for permission prompts",
      "  --permission-prompts <where>   Where permission prompts are answered",
      "  --setting-sources <sources>    Setting sources to load",
      "  --model <model>                Model for the session",
      "  --resume <id>                  Resume a conversation",
    ].join("\n"),
  );
  process.exit(0);
}
if (cli[0] === "auth" && cli[1] === "status") {
  out({ loggedIn: true, authMethod: "claude.ai", email: "load-test@example.com", subscriptionType: "max" });
  process.exit(0);
}
if (!cli.includes("-p") && !cli.includes("--print")) {
  process.stderr.write(`fake-claude: nothing to do for: ${cli.join(" ")}\n`);
  process.exit(2);
}

// The real CLI names itself, and the resource sampler counts `claude`
// processes by that name.
process.title = "claude";

// The memory the real CLI holds. Filled, not just allocated: an untouched
// allocation is never resident and would measure nothing.
const held = rssMb > 0 ? Buffer.alloc(rssMb * 1024 * 1024, 1) : null;

const resumeAt = cli.indexOf("--resume");
const sessionId = resumeAt >= 0 && cli[resumeAt + 1] ? cli[resumeAt + 1] : randomUUID();
const template = readFileSync(fixture, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

const WORDS = "a stand in for claude code streaming one token after another so the harness has something to render".split(" ");
const textOf = (from, n) => {
  let text = "";
  for (let i = from; i < from + n; i++) text += (i > 0 && i % 80 === 0 ? "\n\n" : i > 0 ? " " : "") + WORDS[i % WORDS.length];
  return text;
};
const answer = textOf(0, length);

let interrupted = false;
let stdinClosed = false;
let onStdinClosed = () => {};
const input = createInterface({ input: process.stdin });
const firstLine = new Promise((resolve) => input.once("line", resolve));
input.on("close", () => {
  stdinClosed = true;
  onStdinClosed();
});

process.on("SIGINT", () => {
  interrupted = true;
});
process.on("SIGTERM", () => process.exit(143));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (line) => {
  const copy = { ...line };
  if ("session_id" in copy) copy.session_id = sessionId;
  if (copy.type === "system" && copy.subtype === "init") copy.cwd = process.cwd();
  if ("uuid" in copy) copy.uuid = randomUUID();
  return copy;
};

async function streamText(index) {
  const interval = (1000 * chunk) / rate;
  const started = performance.now();
  for (let sent = 0; sent < length && !interrupted; ) {
    const n = Math.min(chunk, length - sent);
    out(
      stamp({
        type: "stream_event",
        event: { type: "content_block_delta", index, delta: { type: "text_delta", text: textOf(sent, n) } },
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: "",
      }),
    );
    sent += n;
    const wait = started + (sent / chunk) * interval - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

await firstLine;
const startedAt = Date.now();
let textStreamed = false;
for (const line of template) {
  if (interrupted) break;
  const event = line.type === "stream_event" ? line.event : null;
  // The fixture's own text deltas are replaced, all at once, by ours.
  if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
    if (!textStreamed) {
      textStreamed = true;
      await streamText(event.index);
    }
    continue;
  }
  if (line.type === "assistant" && line.message?.content?.some((block) => block.type === "text")) {
    out(stamp({ ...line, message: { ...line.message, content: [{ type: "text", text: answer }] } }));
    continue;
  }
  if (line.type === "result") {
    out(
      stamp({
        ...line,
        result: answer,
        duration_ms: Date.now() - startedAt,
        usage: { ...line.usage, output_tokens: length },
      }),
    );
    continue;
  }
  out(stamp(line));
}

if (interrupted) {
  out({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: sessionId,
    duration_ms: Date.now() - startedAt,
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
    result: null,
  });
}

// The harness closes stdin once it has read the result; the real CLI waits
// for that, and so does this -- but not for ever.
if (!stdinClosed) {
  await Promise.race([new Promise((resolve) => (onStdinClosed = resolve)), sleep(30_000)]);
}
if (held) held[0] = 0;
process.exit(0);
