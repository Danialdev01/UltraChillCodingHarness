import { splitThinking, type ChatMessage } from "./chat-messages.js";

/**
 * Thumbs on an answer, and the conversation as text.
 *
 * A rating is remembered per conversation -- the thread -- and per turn
 * inside it, in this browser only. Nothing reads it yet: the buttons exist so
 * the reaction is captured at the moment it is felt, and what happens to it
 * is a later decision. Keeping it out of the event log until then means no
 * event type has to be designed for something that does nothing.
 */

export type Rating = "up" | "down";

const KEY_PREFIX = "ucch:feedback:";

/** The store behind `readRatings` and `writeRating`; `localStorage` in the browser. */
export interface RatingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function store(): RatingStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Blocked storage throws on access rather than returning undefined.
    return null;
  }
}

/** Every rating in a conversation, by turn. Empty when nothing is stored or storage is off. */
export function readRatings(threadId: string, from: RatingStore | null = store()): Record<string, Rating> {
  try {
    const raw = from?.getItem(KEY_PREFIX + threadId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const ratings: Record<string, Rating> = {};
    for (const [turn, value] of Object.entries(parsed)) {
      if (value === "up" || value === "down") ratings[turn] = value;
    }
    return ratings;
  } catch {
    return {};
  }
}

/**
 * Sets or clears one turn's rating. Returns the conversation's ratings after
 * the change, so the caller can render from the same thing it stored.
 */
export function writeRating(
  threadId: string,
  turnId: string,
  rating: Rating | null,
  to: RatingStore | null = store(),
): Record<string, Rating> {
  const ratings = readRatings(threadId, to);
  if (rating) ratings[turnId] = rating;
  else delete ratings[turnId];
  try {
    to?.setItem(KEY_PREFIX + threadId, JSON.stringify(ratings));
  } catch {
    // Quota, private mode: the click still updates the screen.
  }
  return ratings;
}

/**
 * The conversation as plain text, for the clipboard.
 *
 * What the reader saw: the messages typed and the answers given. The model's
 * thinking and its tool calls are left out, the same as they are folded away
 * on screen -- the transcript is the conversation, not the work behind it.
 * A file that rode along with a message is named, since the words around it
 * usually refer to it.
 */
export function transcript(messages: readonly ChatMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const files = message.attachments?.map((f) => f.name) ?? [];
      const body = [message.text, files.length ? `[attached: ${files.join(", ")}]` : ""]
        .filter(Boolean)
        .join("\n");
      if (body) blocks.push(`User:\n${body}`);
      continue;
    }

    const answer = message.parts
      .flatMap((part) =>
        part.kind === "text"
          ? splitThinking(part.text)
              .filter((s) => s.kind === "answer")
              .map((s) => s.text)
          : [],
      )
      .join("")
      .trim();
    const tail = message.error ? `[failed: ${message.error}]` : "";
    const body = [answer, tail].filter(Boolean).join("\n");
    if (body) blocks.push(`Assistant:\n${body}`);
  }
  return blocks.join("\n\n");
}
