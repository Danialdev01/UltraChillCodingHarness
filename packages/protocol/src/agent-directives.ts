import { ATTACHMENTS_MARKER } from "./attachments.js";

/**
 * `@reviewer` and `@council`: what a message asks of the server besides its
 * own answer.
 *
 * One parser, used by the composer (chips, inline errors) and by the server,
 * whose reading decides. A mention is taken out of the text before any
 * harness sees it. Pure, with no zod: the browser imports it.
 */

export const PEER_REVIEW_MAX_REVIEWERS = 3;
export const COUNCIL_MIN = 2;
export const COUNCIL_MAX = 5;
export const COUNCIL_MAX_ROUNDS = 3;
export const COUNCIL_DEFAULT_SIZE = 3;
export const COUNCIL_DEFAULT_ROUNDS = 1;

/** In a mention's parentheses: the session's own model, in place of a name. */
export const SAME_MODEL = "same";

export interface ReviewerDirective {
  /** As the person named them; empty: chosen for them. `same` is the session's own. */
  models: string[];
  /** Fix what the review finds, then review once more. */
  fix: boolean;
  /** The message holds nothing else: review the answer before it. */
  previous: boolean;
}

export interface CouncilDirective {
  models: string[];
  /** Null: as many as are named, else the project's default. */
  size: number | null;
  /** Discussion rounds after the opening answers. Null: the project's default. */
  rounds: number | null;
  /** Once concluded, carry the recommendation out. */
  implement: boolean;
}

export interface MessageDirectives {
  reviewer?: ReviewerDirective;
  council?: CouncilDirective;
}

export interface DirectiveError {
  message: string;
  start: number;
  end: number;
}

export interface DirectiveRange {
  kind: "reviewer" | "council";
  start: number;
  end: number;
}

export interface ParsedDirectives extends MessageDirectives {
  /** The message with its mentions taken out. */
  text: string;
  /** Where the mentions stand in the message as typed. */
  ranges: DirectiveRange[];
  errors: DirectiveError[];
}

/** Opens a word; ends where a word would, so `@reviewer.md` and `@reviewer/x` stay file mentions. */
const MENTION = /(?<=^|\s)@(reviewer|council)(?:(\([^()\n]*\))|(?=\()|(?=[,.;:!?]*(?:\s|$)))/gi;
const MODEL_NAME_MAX = 100;

/** Code, blanked out at the same length: an `@reviewer` in it is quoted, not asked for. */
function maskCode(text: string): string {
  const blank = (code: string) => code.replace(/[^\n]/g, "\u0000");
  return text
    .replace(/^[ \t]*(```+|~~~+)[^\n]*(?:\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))|$)/gm, blank)
    .replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, blank);
}

export function parseDirectives(message: string): ParsedDirectives {
  // What an attachment says is never the person asking.
  const marker = message.indexOf(ATTACHMENTS_MARKER);
  const typed = marker === -1 ? message : message.slice(0, marker);
  const rest = marker === -1 ? "" : message.slice(marker);

  const out: ParsedDirectives = { text: message, ranges: [], errors: [] };
  const cuts: { start: number; end: number }[] = [];
  for (const match of maskCode(typed).matchAll(MENTION)) {
    const kind = match[1]!.toLowerCase() as "reviewer" | "council";
    const start = match.index;
    const end = start + match[0].length;
    const fail = (text: string) => out.errors.push({ message: text, start, end });
    out.ranges.push({ kind, start, end });
    cuts.push({ start, end });
    if (match[2] === undefined && typed[end] === "(") {
      fail(`Close the parenthesis after @${kind}`);
      continue;
    }
    if (out[kind]) {
      fail(`A message can have one @${kind}`);
      continue;
    }
    const tokens = (match[2] ?? "")
      .replace(/^\(|\)$/g, "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const parsed = kind === "reviewer" ? readReviewer(tokens) : readCouncil(tokens);
    if (parsed.error) fail(parsed.error);
    if (kind === "reviewer") out.reviewer = parsed.value as ReviewerDirective;
    else out.council = parsed.value as CouncilDirective;
  }
  if (cuts.length === 0) return out;

  let text = typed;
  for (const { start, end } of [...cuts].reverse()) {
    const before = text.slice(0, start).replace(/[ \t]+$/, "");
    const after = text.slice(end).replace(/^[,:]?[ \t]+/, "");
    const open = before === "" || before.endsWith("\n");
    text = `${before}${open || after === "" || after.startsWith("\n") ? "" : " "}${after}`;
  }
  text = text.trim();
  out.text = text && rest ? `${text}\n\n${rest}` : `${text}${rest}`;

  const alone = !/[\p{L}\p{N}]/u.test(text) && rest === "";
  if (out.council && alone) {
    out.errors.push({ message: "Ask the council a question", ...out.ranges.find((r) => r.kind === "council")! });
  } else if (out.reviewer && alone) {
    out.reviewer.previous = true;
    out.text = "";
  }
  return out;
}

function readReviewer(tokens: string[]): { value: ReviewerDirective; error?: string } {
  const value: ReviewerDirective = { models: [], fix: false, previous: false };
  let error: string | undefined;
  for (const token of tokens) {
    const word = token.toLowerCase();
    if (word === "fix") value.fix = true;
    else if (word === "auto") continue;
    else if (word === "implement" || /^rounds\b/.test(word) || /^\d+$/.test(word)) {
      error ??= `@reviewer takes model names and fix, not "${token}"`;
    } else if (token.length > MODEL_NAME_MAX) error ??= "That model name is too long";
    else value.models.push(word === SAME_MODEL ? SAME_MODEL : token);
  }
  if (value.models.length > PEER_REVIEW_MAX_REVIEWERS) error ??= `@reviewer takes at most ${PEER_REVIEW_MAX_REVIEWERS} models`;
  return { value, ...(error ? { error } : {}) };
}

function readCouncil(tokens: string[]): { value: CouncilDirective; error?: string } {
  const value: CouncilDirective = { models: [], size: null, rounds: null, implement: false };
  let error: string | undefined;
  for (const token of tokens) {
    const word = token.toLowerCase();
    const rounds = /^rounds\s*=?\s*(.*)$/.exec(word);
    if (word === "implement") value.implement = true;
    else if (word === "auto") continue;
    else if (rounds) {
      if (!/^\d+$/.test(rounds[1]!) || Number(rounds[1]) > COUNCIL_MAX_ROUNDS) error ??= `@council takes rounds=0 to rounds=${COUNCIL_MAX_ROUNDS}`;
      else value.rounds = Number(rounds[1]);
    } else if (/^\d+$/.test(word)) {
      const size = Number(word);
      if (size < COUNCIL_MIN || size > COUNCIL_MAX) error ??= `@council takes ${COUNCIL_MIN} to ${COUNCIL_MAX} members`;
      else value.size = size;
    } else if (word === "fix") error ??= "@council takes implement, not fix";
    else if (token.length > MODEL_NAME_MAX) error ??= "That model name is too long";
    else value.models.push(word === SAME_MODEL ? SAME_MODEL : token);
  }
  if (value.models.length > COUNCIL_MAX) error ??= `@council takes at most ${COUNCIL_MAX} members`;
  if (value.size !== null && value.models.length > value.size) error ??= `@council names ${value.models.length} models for ${value.size} members`;
  return { value, ...(error ? { error } : {}) };
}

/** How many members a council has: as asked, else as named, else the default. */
export function councilSize(directive: CouncilDirective, fallback: number = COUNCIL_DEFAULT_SIZE): number {
  return directive.size ?? (directive.models.length >= COUNCIL_MIN ? directive.models.length : fallback);
}

/** A mention as it is typed, for a message shown again. */
export function directiveText(kind: "reviewer" | "council", directive: Partial<ReviewerDirective & CouncilDirective>): string {
  const inside = [
    ...(directive.models ?? []),
    ...(directive.size ? [String(directive.size)] : []),
    ...(directive.rounds !== null && directive.rounds !== undefined ? [`rounds=${directive.rounds}`] : []),
    ...(directive.fix ? ["fix"] : []),
    ...(directive.implement ? ["implement"] : []),
  ];
  return `@${kind}${inside.length ? `(${inside.join(", ")})` : ""}`;
}
