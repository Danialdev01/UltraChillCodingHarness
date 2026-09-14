import type { DomainEvent, MessageImage } from "@ucch/protocol";
import { summaryMessage } from "./context.js";
import type { ChatMessage, ToolCall, UserContentPart } from "./completion.js";

/**
 * What a tool call that never ran gets told.
 *
 * A crash between dispatching a tool and recording its result leaves a call
 * with no reply, and an assistant message carrying an unanswered `tool_call`
 * is rejected outright by OpenAI-shaped APIs -- so the thread would be dead
 * rather than merely interrupted. The placeholder keeps any prefix of the log
 * rebuildable, which is the whole point of writing `agent.message` before the
 * tools run.
 */
export const INTERRUPTED = "Interrupted before this tool ran.";

/**
 * Folds the durable event log back into a conversation.
 *
 * The log is the only source: nothing is cached in memory, so a restarted
 * server continues a thread exactly where it left off. Deltas are skipped --
 * they are transient and the assembled `agent.message` is what they add up
 * to -- and so is `context.injected`, with one exception.
 *
 * That exception is compaction. A `context.injected` carrying
 * `source: "compaction"` is a checkpoint: everything logged before it folds
 * into its summary, and everything after it replays normally. The events it
 * replaces are never deleted -- the log stays the whole truth, and the UI
 * still renders the turns the model can no longer see. This is only the
 * projection of that log into what the model is shown.
 *
 * The last checkpoint wins, so a thread long enough to compact twice starts
 * from the second summary rather than stacking them.
 */
export function rebuild(
  events: readonly DomainEvent[],
  images: ReadonlyMap<string, string> = new Map(),
): ChatMessage[] {
  let checkpoint = -1;
  let summary = "";
  events.forEach((event, index) => {
    if (event.type === "context.injected" && event.source === "compaction") {
      checkpoint = index;
      summary = event.content;
    }
  });

  if (checkpoint >= 0) {
    return [summaryMessage(summary), ...replay(events.slice(checkpoint + 1), images)];
  }
  return replay(events, images);
}

/** The fold itself, over whatever window `rebuild` decided the model sees. */
function replay(
  events: readonly DomainEvent[],
  images: ReadonlyMap<string, string>,
): ChatMessage[] {
  // Results are looked up rather than read in order: they are appended as
  // each tool finishes, which for parallel calls is not the order the model
  // asked for them in, and the conversation must not inherit that shuffle.
  const results = new Map<string, string>();
  for (const event of events) {
    if (event.type === "agent.tool_result") {
      results.set(event.toolUseId, event.content || INTERRUPTED);
    }
  }

  const messages: ChatMessage[] = [];

  for (const event of events) {
    if (event.type === "user.message") {
      messages.push({ role: "user", content: userContent(event.text, event.images, images) });
      continue;
    }
    if (event.type !== "agent.message") continue;

    const { text, toolCalls } = readBlocks(event.content);
    // An assistant turn that said nothing and called nothing is not a turn.
    // Sending `content: null` with no tool calls is rejected by some
    // providers and means nothing to any of them.
    if (text === "" && toolCalls.length === 0) continue;

    messages.push({
      role: "assistant",
      content: text === "" ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    // In the assistant's order, not the log's.
    for (const call of toolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: results.get(call.id) ?? INTERRUPTED,
      });
    }
  }

  return messages;
}

/**
 * Reads the content blocks back out of a stored `agent.message`.
 *
 * The blocks are `unknown` in the protocol, and they are read defensively
 * here for a reason: this runs over rows written by older versions of the
 * code, and a thread that cannot be rebuilt is a thread the user has lost.
 */
function readBlocks(content: readonly unknown[]): { text: string; toolCalls: ToolCall[] } {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      text += record.text;
      continue;
    }
    if (record.type !== "tool_use") continue;

    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!id || !name) continue;

    toolCalls.push({
      id,
      type: "function",
      // The raw string the provider sent, replayed byte for byte.
      // Re-stringifying the parsed input would reorder keys and respace
      // separators, and the cached prefix would break on every replay
      // without anything looking wrong.
      function: { name, arguments: rawArguments(record) },
    });
  }

  return { text, toolCalls };
}

function rawArguments(block: Record<string, unknown>): string {
  if (typeof block.arguments === "string" && block.arguments !== "") return block.arguments;
  // Written before `arguments` was stored, or by a provider that sent none.
  // Reconstructing from `input` loses the original bytes, which costs the
  // cache; it does not cost correctness, so it is the right fallback.
  if (block.input !== undefined && block.input !== null) {
    try {
      return JSON.stringify(block.input);
    } catch {
      return "{}";
    }
  }
  return "{}";
}


/**
 * A user message as text, or as text and pictures.
 *
 * Falls back to the plain string whenever there is nothing to show -- no
 * images on the message, or none of them still readable. That keeps the
 * ordinary message byte-identical to what it has always been, which is what
 * the prompt cache is matching on.
 *
 * An image whose bytes are gone is named rather than dropped. The model was
 * told a picture was attached; leaving it to wonder why the message reads as
 * if there were one is worse than saying it expired.
 */
function userContent(
  text: string,
  attached: readonly MessageImage[] | undefined,
  images: ReadonlyMap<string, string>,
): string | UserContentPart[] {
  if (!attached?.length) return text;

  const parts: UserContentPart[] = [];
  const missing: string[] = [];
  for (const image of attached) {
    const url = images.get(image.uploadId);
    if (url) parts.push({ type: "image_url", image_url: { url } });
    else missing.push(image.name);
  }

  if (parts.length === 0) return note(text, missing);
  // The text leads: a picture answers a question, and the question is what
  // the person actually typed.
  return [{ type: "text", text: note(text, missing) }, ...parts];
}

function note(text: string, missing: readonly string[]): string {
  if (missing.length === 0) return text;
  return `${text}\n\n(${missing.join(", ")} ${
    missing.length === 1 ? "was" : "were"
  } attached to this message but the image is no longer available.)`;
}
