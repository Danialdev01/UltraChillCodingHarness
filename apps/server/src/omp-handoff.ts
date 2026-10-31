import { CHARS_PER_TOKEN, type DomainEvent } from "@ucch/protocol";
import type { OmpAskInput } from "@ucch/providers";

/**
 * The handoff brief (solution §5.4): what a thread has done, written by a
 * small model from the thread's own log, for whichever provider carries the
 * work on. Every provider gets the brief, OMP included -- there is no
 * non-interactive import of another CLI's session (spike report, OM0.5),
 * and UCCH's log is already the one record all of them share.
 *
 * Two halves. `renderTranscript` turns the log into plain text: what each
 * side said, each tool call with its result cut short, and the files the
 * thread changed. `buildHandoffBrief` hands that to `omp -p --no-session
 * --no-tools --model @smol` with a fixed instruction: no tools, because the
 * brief is written from the transcript alone, and no session, because
 * nothing about it should outlive the call.
 *
 * The transcript leaves the server for a model, so anything that looks
 * like a credential is masked before it is sent, and it is held to a token
 * budget, keeping the newest of the conversation when it is over.
 */

/** A tool's result, as the transcript keeps it. */
export const TOOL_RESULT_BYTES = 2 * 1024;

/** A tool call's arguments, as the transcript keeps them. */
const TOOL_INPUT_CHARS = 500;

/** The transcript's budget, by the shared estimate: well inside a small model's window. */
export const TRANSCRIPT_TOKENS = 24_000;

/**
 * The instruction, modelled on OMP's own handoff contents ("the work
 * completed so far, the decisions that matter, and the next steps",
 * https://omp.sh/docs/handoff). The transcript arrives ahead of it.
 */
export const HANDOFF_INSTRUCTION = [
  "Above is the transcript of a coding session that another agent will continue in the same working tree.",
  "Write the handoff brief that agent starts from. Cover, in this order:",
  "1. The goal, as the user stated it and as it developed.",
  "2. The work completed so far, naming the files changed.",
  "3. The decisions that matter, with the reasons, and anything ruled out.",
  "4. The next steps, most important first, and any open questions.",
  "Be specific and brief. Write only the brief: no preamble, and no closing remarks.",
  "Never copy secrets, keys or tokens into it.",
].join("\n");

/** The prompt argument: the fixed instruction and, when there is one, what to focus on. */
export function handoffPrompt(focus?: string): string {
  const trimmed = focus?.trim();
  return trimmed ? `${HANDOFF_INSTRUCTION}\n\nFocus on: ${trimmed}` : HANDOFF_INSTRUCTION;
}

/** A value, keeping the quotes it came in: `"x"` stays a string where a reader expects one. */
const redact = (value: string) => (/^(["']).*\1$/s.test(value) ? `${value[0]}<redacted>${value[0]}` : "<redacted>");

/**
 * Credentials as they show up in a transcript: an environment-style name
 * that says it is one, assigned (`OPENROUTER_API_KEY=...`, `GITHUB_TOKEN:
 * ...`); a config key that is exactly one (`"apiKey": "..."`, `password:
 * ...`) -- not one that merely contains the word, so `maxTokens: 24000`
 * survives; a bearer header; and the vendors' own key prefixes.
 */
const SECRET_PATTERNS: readonly [RegExp, (...groups: string[]) => string][] = [
  [
    /\b([A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/g,
    (_match, name, sep, value) => `${name}${sep}${redact(value!)}`,
  ],
  [
    /(["']?)\b(api[_-]?key|secret|client[_-]?secret|password|passwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
    (_match, quote, name, sep, value) => `${quote}${name}${quote}${sep}${redact(value!)}`,
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, (_match, bearer) => `${bearer}<redacted>`],
  [/\b(?:sk-(?:or-|ant-|proj-)?|ghp_|gho_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}/g, () => "<redacted>"],
];

/** The text with anything that looks like a credential replaced by `<redacted>`. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replace] of SECRET_PATTERNS) out = out.replace(pattern, (...args: string[]) => replace(...args));
  return out;
}

/** At most `bytes` of UTF-8, cut on a character, with how much was left out. */
function clip(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= bytes) return text;
  // Back off to the start of a character, so the cut never splits one.
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return `${encoded.subarray(0, end).toString("utf8")}\n[… ${encoded.byteLength - end} more bytes]`;
}

function textOf(content: readonly unknown[]): string {
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

function inputOf(input: unknown): string {
  if (input === undefined || input === null) return "";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > TOOL_INPUT_CHARS ? `${text.slice(0, TOOL_INPUT_CHARS)}…` : text;
}

/**
 * A thread's log as plain text, oldest first: what the user and the agent
 * said, each tool call with its result (at most `TOOL_RESULT_BYTES`), any
 * summary an earlier compaction left, and, last, the files changed. Over
 * `maxTokens` the oldest sections go first, with a line saying so; the
 * list of files always stays. Secrets are masked throughout.
 */
export function renderTranscript(events: readonly DomainEvent[], options: { maxTokens?: number } = {}): string {
  const maxChars = (options.maxTokens ?? TRANSCRIPT_TOKENS) * CHARS_PER_TOKEN;
  const sections: string[] = [];
  const calls = new Map<string, { at: number; name: string; input: string }>();
  const files = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case "user.message":
        if (event.text.trim()) sections.push(`## User\n${event.text.trim()}`);
        break;
      case "agent.message": {
        const text = textOf(event.content);
        if (text) sections.push(`## Assistant\n${text}`);
        break;
      }
      case "agent.tool_use":
        calls.set(event.toolUseId, { at: sections.length, name: event.name, input: inputOf(event.input) });
        sections.push(`### Tool call: ${event.name}(${inputOf(event.input)})`);
        break;
      case "agent.tool_result": {
        const call = calls.get(event.toolUseId);
        const head = call ? `### Tool call: ${call.name}(${call.input})` : "### Tool result";
        const body = `${event.isError ? "Failed:\n" : ""}${clip(event.content.trim(), TOOL_RESULT_BYTES)}`;
        // Under its call, so a reader sees each call with what it returned.
        if (call) sections[call.at] = `${head}\n${body}`;
        else sections.push(`${head}\n${body}`);
        break;
      }
      case "context.injected":
        // What the model was handed is not the conversation, but what an
        // earlier compaction or handoff kept of it is.
        if (event.source === "compaction" && event.content.trim()) {
          sections.push(`## Summary of the conversation before this point\n${event.content.trim()}`);
        }
        break;
      case "file.changed":
        files.set(event.path, event.change);
        break;
      default:
        break;
    }
  }

  const tail = files.size
    ? `## Files changed\n${[...files].map(([path, change]) => `- ${path} (${change})`).join("\n")}`
    : "";
  const masked = sections.map(maskSecrets);
  const maskedTail = maskSecrets(tail);
  // The newest sections that fit, beside the list of files.
  let budget = maxChars - maskedTail.length;
  const kept: string[] = [];
  for (let i = masked.length - 1; i >= 0; i--) {
    const section = masked[i]!;
    if (section.length + 2 > budget) break;
    kept.unshift(section);
    budget -= section.length + 2;
  }
  const dropped = masked.length - kept.length;
  const parts = [
    ...(dropped > 0 ? [`[${dropped} earlier ${dropped === 1 ? "part" : "parts"} of the conversation left out for length]`] : []),
    ...kept,
    ...(maskedTail ? [maskedTail] : []),
  ];
  return parts.join("\n\n");
}

/**
 * The new thread's first message (solution §5.4): the brief, marked as one
 * so the agent reads it as where the work stands rather than as a request,
 * then the request.
 */
export function handoffMessage(brief: string): string {
  return `<handoff-brief>\n${brief.trim()}\n</handoff-brief>\n\nContinue from here.`;
}

/** The new thread's title: the old one's, saying it carries it on. */
export function handoffTitle(title: string): string {
  const base = title.replace(/^Continued: /, "").trim() || "Untitled";
  return `Continued: ${base}`.slice(0, 200);
}

/** What `buildHandoffBrief` asks with: `OmpProvider.ask`, or anything that answers as it does. */
export interface BriefAsker {
  ask(input: OmpAskInput): Promise<string>;
}

/**
 * Writes the brief for a thread: its transcript on stdin, the instruction
 * (and `focus`) as the prompt, on the overlay's `smol` role. Rejects with
 * OMP's error, or when the thread has nothing to hand off.
 */
export async function buildHandoffBrief(input: {
  omp: BriefAsker;
  ctx: OmpAskInput["ctx"];
  files: OmpAskInput["omp"];
  events: readonly DomainEvent[];
  focus?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const transcript = renderTranscript(input.events, input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {});
  if (!transcript) throw new Error("this thread has nothing to hand off yet");
  return input.omp.ask({
    ctx: input.ctx,
    omp: input.files,
    prompt: handoffPrompt(input.focus),
    stdin: `<transcript>\n${transcript}\n</transcript>\n`,
    model: "@smol",
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
