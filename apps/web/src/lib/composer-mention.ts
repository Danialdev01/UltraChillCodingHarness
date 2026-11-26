/**
 * The composer's `@` menu beyond files (plan4 §4.1): `@reviewer` and
 * `@council`, and the model step that follows one, inside its parentheses.
 *
 * Pure, like `file-mention.ts`: the textarea hands over its text and caret,
 * and gets back the draft as it should read. The server parses what is sent
 * with the same `parseDirectives`, so what the composer offers here is what
 * the server will accept.
 */

import { COUNCIL_MAX, PEER_REVIEW_MAX_REVIEWERS, SAME_MODEL } from "@ucch/protocol/plain";
import type { Mention } from "@/lib/file-mention";

export type AgentMentionName = "reviewer" | "council";

export interface AgentMention {
  name: AgentMentionName;
  label: string;
  description: string;
}

export const AGENT_MENTIONS: readonly AgentMention[] = [
  { name: "reviewer", label: "Reviewer", description: "Another model checks the answer this message gets" },
  { name: "council", label: "Council", description: "Several models discuss the question, then the agent answers" },
];

/** The most models each takes inside its parentheses. */
export const AGENT_MENTION_MAX: Record<AgentMentionName, number> = { reviewer: PEER_REVIEW_MAX_REVIEWERS, council: COUNCIL_MAX };

/** The agent mentions a typed `@word` could still become. */
export function matchAgentMentions(query: string): AgentMention[] {
  const q = query.toLowerCase();
  if (/[^a-z]/.test(q)) return [];
  return AGENT_MENTIONS.filter((mention) => mention.name.startsWith(q));
}

/** The draft with the `@word` at `mention` replaced by `@name(`, the caret inside, for the model step. */
export function insertAgentMention(text: string, mention: Mention, caret: number, name: AgentMentionName): { text: string; caret: number } {
  const token = `@${name}(`;
  const after = text.slice(caret);
  // Closed now, so a draft left here still parses; models go before the `)`.
  const closing = after.startsWith(")") ? "" : ")";
  return { text: text.slice(0, mention.start) + token + closing + after, caret: mention.start + token.length };
}

/** Inside an `@reviewer(…)` or `@council(…)`, where the caret is. */
export interface AgentArgs {
  name: AgentMentionName;
  /** Index of the `@`. */
  start: number;
  /** Index just after the `(`. */
  open: number;
  /** Index of the closing `)`, or the end of the line when there is none. */
  close: number;
  /** What is already in the parentheses before the token being typed, trimmed. */
  before: string[];
  /** The token being typed, up to the caret. */
  query: string;
}

const OPENER = /(?<=^|\s)@(reviewer|council)\(/gi;

/** The mention whose parentheses the caret is in, or null. */
export function agentArgsAt(text: string, caret: number): AgentArgs | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = (() => {
    const at = text.indexOf("\n", caret);
    return at === -1 ? text.length : at;
  })();
  const line = text.slice(lineStart, lineEnd);
  let found: AgentArgs | null = null;
  for (const match of line.matchAll(OPENER)) {
    const start = lineStart + match.index;
    const open = start + match[0].length;
    if (open > caret) break;
    const closeAt = text.indexOf(")", open);
    const close = closeAt === -1 || closeAt > lineEnd ? lineEnd : closeAt;
    if (caret > close) continue;
    const inside = text.slice(open, caret);
    const parts = inside.split(",");
    found = {
      name: match[1]!.toLowerCase() as AgentMentionName,
      start,
      open,
      close,
      before: parts.slice(0, -1).map((p) => p.trim()).filter(Boolean),
      query: parts.at(-1)!.trimStart(),
    };
  }
  return found;
}

/** Model tokens already named: what the step leaves out of its list. */
export function namedModels(args: AgentArgs): Set<string> {
  return new Set(args.before.map((token) => token.toLowerCase()));
}

/**
 * The draft with `model` put where the caret's token is. Room left for
 * another: `, ` and the caret after it; at the limit, the caret goes past
 * the `)` and the step is over. `null` (Auto) empties the parentheses: the
 * server chooses.
 */
export function pickAgentModel(text: string, args: AgentArgs, model: string | null): { text: string; caret: number } {
  const closed = text[args.close] === ")";
  const tail = text.slice(closed ? args.close + 1 : args.close);
  if (model === null) {
    // Auto: no parentheses at all, unless an option (fix, rounds=…) is in them.
    const options = args.before.filter((t) => !isModelToken(t));
    const head = `@${args.name}${options.length ? `(${options.join(", ")})` : ""}`;
    const spaced = tail.startsWith(" ") || tail === "" ? tail : ` ${tail}`;
    const next = text.slice(0, args.start) + head + (spaced === "" ? " " : spaced);
    return { text: next, caret: args.start + head.length + 1 };
  }
  const tokens = [...args.before, model];
  const models = tokens.filter(isModelToken).length;
  const full = models >= AGENT_MENTION_MAX[args.name];
  const inside = tokens.join(", ") + (full ? "" : ", ");
  const head = `@${args.name}(${inside}`;
  const next = text.slice(0, args.start) + head + ")" + (full && !tail.startsWith(" ") ? ` ${tail}` : tail);
  return { text: next, caret: args.start + head.length + (full ? 2 : 0) };
}

/** Closes the step: the caret past the `)`, with the dangling `, ` dropped. */
export function closeAgentArgs(text: string, args: AgentArgs): { text: string; caret: number } {
  const closed = text[args.close] === ")";
  const tail = text.slice(closed ? args.close + 1 : args.close);
  const tokens = [...args.before, ...(args.query.trim() ? [args.query.trim()] : [])];
  const head = tokens.length ? `@${args.name}(${tokens.join(", ")})` : `@${args.name}`;
  const spaced = tail.startsWith(" ") ? tail : ` ${tail}`;
  return { text: text.slice(0, args.start) + head + spaced, caret: args.start + head.length + 1 };
}

/** A token that names a model rather than an option. */
function isModelToken(token: string): boolean {
  const word = token.trim().toLowerCase();
  return !(word === "fix" || word === "implement" || word === "auto" || /^rounds\b/.test(word) || /^\d+$/.test(word));
}

export { SAME_MODEL };
