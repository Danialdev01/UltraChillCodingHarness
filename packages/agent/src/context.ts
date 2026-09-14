import { CHARS_PER_TOKEN, estimateTokens, type TokenUsage } from "@ucch/protocol";
import type { ChatMessage, Complete } from "./completion.js";

/**
 * Keeping a thread inside the model's window.
 *
 * The loop used to replay the entire log every turn with no bound at all, so
 * a long thread ended in a provider 400 that surfaced as `agent.turn_failed`
 * -- the work interrupted, and nothing said about why until someone read the
 * error. Two escalations sit between that and a normal turn, in this order:
 *
 *  1. **prune** the oldest tool results, which are almost always the largest
 *     thing in a coding thread and almost always the stalest: a file read
 *     from thirty messages ago has usually been edited twice since;
 *  2. **compact** the older half of the conversation into one summary, which
 *     costs a model call and is therefore the second answer, not the first.
 *
 * Both rewrite history in the middle of the prefix and so cost the prompt
 * cache from the point they touch. That is the trade they exist to make, and
 * it is why each is gated on actually reclaiming something: paying the cache
 * to reclaim four hundred tokens would be a straight loss. The rolling
 * breakpoints in `apps/server/src/openrouter.ts` re-warm on the next
 * iteration either way.
 */

/**
 * What one image is counted as weighing.
 *
 * A flat figure, and deliberately a rough one: the real cost depends on the
 * provider and on the picture's dimensions, neither of which is known here
 * without decoding it. This is in the right order of magnitude for a
 * screenshot at the sizes providers tile at, which is all the budget needs.
 */
const IMAGE_TOKENS = 1_100;

/** Where pruning starts, as a fraction of the usable window. */
export const PRUNE_RATIO = 0.7;

/** Where compaction starts. Above pruning, because it costs a model call. */
export const COMPACT_RATIO = 0.85;

/**
 * Tool results younger than this are not pruned on the ordinary pass.
 *
 * The last few are what the model is actually working from -- the file it is
 * about to edit, the test output it is about to fix. Pruning those to save
 * tokens would save the tokens and lose the turn.
 *
 * It is a preference, not a floor, and the distinction matters: six results
 * at the 30 KB a tool result may reach is some 45k tokens, which is larger
 * than the whole usable window of a small model. Held as a floor it would
 * turn "this thread is getting long" into "this model cannot be used". The
 * caller lowers it on a last pass rather than failing the turn.
 */
export const KEEP_RECENT_RESULTS = 6;

/** What a pruned tool result is cut down to. */
const PRUNED_RESULT_BYTES = 800;

/** Below this, pruning a result is not worth the cache it costs. */
const PRUNE_WORTH_TOKENS = 2_000;

export interface ContextBudget {
  /**
   * The model's window from the catalogue, or null when it does not publish
   * one. Null disables management entirely rather than guessing a number:
   * a wrong ceiling either compacts a thread that was fine or fails to
   * compact one that was not.
   */
  contextLength: number | null;
  /** Held back for the reply, and for the estimate being an estimate. */
  reserveTokens: number;
}

/** Roughly what these messages weigh. */
export function measure(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") chars += message.content.length;
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        // An image is not its own length. A `data:` URL runs to hundreds of
        // thousands of characters and bills as roughly a thousand tokens, so
        // counting the base64 would overstate a screenshot by two orders of
        // magnitude and compact a thread that had plenty of room left.
        if (part.type === "image_url") chars += IMAGE_TOKENS * CHARS_PER_TOKEN;
        else chars += part.text.length;
      }
    }
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return estimateTokens(chars);
}

/**
 * The largest share of a window the reserve may take.
 *
 * A flat reserve is right for a large window and absurd for a small one:
 * holding back 24k of a 32k model leaves a quarter of it usable and compacts
 * threads that were never in trouble. The reserve is whichever is smaller.
 */
const MAX_RESERVE_RATIO = 0.2;

/** The window minus the reserve, or null when there is no window to speak of. */
export function usableTokens(budget: ContextBudget): number | null {
  if (!budget.contextLength || budget.contextLength <= 0) return null;
  const reserve = Math.min(
    budget.reserveTokens,
    Math.floor(budget.contextLength * MAX_RESERVE_RATIO),
  );
  return Math.max(0, budget.contextLength - reserve);
}

/**
 * Replaces the oldest oversized tool results with a bounded head and tail.
 *
 * Oldest first, and it stops as soon as the conversation is back under the
 * threshold: the point is to reclaim enough, not to reclaim everything. A
 * result it rewrites says so in the marker, so the model reads a gap rather
 * than a short answer and knows it can call the tool again.
 *
 * Returns the same array when it changed nothing, which is what the caller
 * checks to decide whether the cache was worth spending.
 */
export function pruneToolResults(
  messages: readonly ChatMessage[],
  targetTokens: number,
  keepRecent: number = KEEP_RECENT_RESULTS,
): { messages: ChatMessage[]; reclaimed: number } {
  const prunable: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") prunable.push(index);
  });

  const candidates = prunable.slice(0, Math.max(0, prunable.length - keepRecent));
  if (candidates.length === 0) return { messages: [...messages], reclaimed: 0 };

  const next = [...messages];
  let current = measure(next);
  let reclaimed = 0;

  for (const index of candidates) {
    if (current <= targetTokens) break;

    const message = next[index]!;
    if (message.role !== "tool") continue;

    const pruned = pruneOne(message.content);
    if (pruned === null) continue;

    const saved = estimateTokens(message.content.length - pruned.length);
    next[index] = { ...message, content: pruned };
    current -= saved;
    reclaimed += saved;
  }

  // The threshold is a guard against spending the cache for nothing, so it
  // does not apply to a last pass that is trying to avoid failing the turn.
  if (reclaimed < PRUNE_WORTH_TOKENS && keepRecent >= KEEP_RECENT_RESULTS) {
    return { messages: [...messages], reclaimed: 0 };
  }
  return { messages: next, reclaimed };
}

/**
 * One result, cut to a head and a tail.
 *
 * Both ends for the same reason `clamp` keeps both: a command's first error
 * is at the top and its verdict is at the bottom. Null when the result is
 * already small enough that rewriting it would cost more cache than it saved.
 */
function pruneOne(content: string): string | null {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= PRUNED_RESULT_BYTES * 2) return null;

  const head = Math.floor(PRUNED_RESULT_BYTES * 0.6);
  const tail = PRUNED_RESULT_BYTES - head;
  const elided = buffer.length - PRUNED_RESULT_BYTES;

  return (
    buffer.subarray(0, head).toString("utf8") +
    `\n\n… ${elided.toLocaleString("en-US")} bytes of an older tool result elided to make ` +
    `room; call the tool again if you need them …\n\n` +
    buffer.subarray(buffer.length - tail).toString("utf8")
  );
}

export interface CompactionInput {
  messages: readonly ChatMessage[];
  apiKey: string;
  /** Deliberately not the coding model: this is a summary, not the work. */
  model: string;
  signal: AbortSignal;
  complete: Complete;
}

export interface CompactionOutcome {
  /** The summary text, for the `context.injected` event and for replay. */
  summary: string;
  /** How many messages from the front it replaces. */
  replacedThrough: number;
  usage: TokenUsage;
  costUsd: number;
}

/**
 * How much of the conversation one compaction folds away.
 *
 * The recent tail is left alone deliberately. A summary of what just happened
 * is worse than what just happened, and the tail is where the model is
 * working; folding it would trade a real transcript for a paraphrase of it.
 */
const COMPACT_FRACTION = 0.6;

const COMPACTION_INSTRUCTIONS = `You are summarising the earlier part of a coding session so it can be dropped from the context window while the work continues.

Write a dense factual record, not prose. Cover, in this order and only where they apply:
- what the person asked for, in their own terms, including anything they ruled out;
- what has been established about the codebase: files, symbols, and how they fit together;
- what has already been changed, file by file;
- what was tried and did not work, and why -- this is what stops it being tried again;
- what is still outstanding.

Name files by path and symbols by name. Do not congratulate anyone, do not describe the conversation as a conversation, and do not invent anything that is not in the transcript.`;

/**
 * Folds the older part of a conversation into a single summary.
 *
 * Never touches the system message, which is the cached prefix, and never the
 * recent tail. The boundary is moved back to the nearest message that is not
 * a tool result, because a `tool` message whose matching `assistant` call has
 * been summarised away is a dangling reference that several providers reject
 * outright.
 */
export async function compact(input: CompactionInput): Promise<CompactionOutcome | null> {
  const first = input.messages[0]?.role === "system" ? 1 : 0;
  const body = input.messages.slice(first);
  if (body.length < 4) return null;

  let boundary = first + Math.floor(body.length * COMPACT_FRACTION);
  while (boundary > first && input.messages[boundary]?.role === "tool") boundary--;
  if (boundary <= first) return null;

  const transcript = input.messages
    .slice(first, boundary)
    .map(render)
    .filter(Boolean)
    .join("\n\n");
  if (!transcript) return null;

  const completion = await input.complete(
    {
      apiKey: input.apiKey,
      model: input.model,
      messages: [
        { role: "system", content: COMPACTION_INSTRUCTIONS },
        { role: "user", content: transcript },
      ],
      signal: input.signal,
    },
    () => {},
  );

  const summary = completion.text.trim();
  if (!summary) return null;

  return {
    summary,
    replacedThrough: boundary,
    usage: completion.usage,
    costUsd: completion.costUsd,
  };
}

/** One message as a line of transcript for the summariser to read. */
function render(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return `[user] ${message.content}`;
    case "assistant": {
      const text = message.content ?? "";
      const calls = (message.tool_calls ?? [])
        .map((call) => `${call.function.name}(${call.function.arguments})`)
        .join(" ");
      return `[assistant] ${text}${calls ? `\ncalled: ${calls}` : ""}`.trim();
    }
    case "tool":
      return `[tool result] ${message.content}`;
    default:
      return "";
  }
}

/**
 * The message a compaction checkpoint replays as.
 *
 * A `user` message rather than a `system` one: the system prompt is the
 * cached prefix and must stay byte-identical, and a second system message
 * partway through the conversation is handled inconsistently across
 * providers. Labelled so the model reads it as a record rather than as
 * something the person just said.
 */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: `[Earlier in this session, summarised so the conversation could continue past the context window:]\n\n${summary}`,
  };
}
