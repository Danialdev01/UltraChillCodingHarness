/**
 * Attachments as the model reads them, shared by the composer that writes the
 * message and the server that prepares the workspace for it.
 *
 * A message carries its attachments as a block after `ATTACHMENTS_MARKER`: a
 * JSON manifest (one line), then the readable text of each file, inlined up
 * to a budget that follows the model's context window. Whatever does not fit
 * is not lost: the server writes every attachment, and the text extracted
 * from it, into the workspace's `.attachments/` folder before the turn runs
 * (`UploadStore.materialize`), and the message names those paths. Every
 * harness can read a workspace file with its own tools, so a 300-page PDF is
 * an excerpt in the message and a file to search, whichever model answers.
 */

import { CHARS_PER_TOKEN } from "./tokens.js";

export const ATTACHMENTS_MARKER = "<ucch:attachments>";

/**
 * Where attachments are copied for the agent to read, relative to the
 * workspace root. Hidden, and ignored by git through a `.gitignore` of its
 * own, so nothing here shows in `git status` or the next commit.
 */
export const ATTACHMENTS_DIR = ".attachments";

/** One attachment as the manifest carries it, for the tag and for the model. */
export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  /** Null when the upload failed, so nothing offers an id that is not there. */
  uploadId: string | null;
  /** Workspace-relative path of the original file, once the turn has placed it. */
  path?: string;
  /** Workspace-relative path of the full extracted text, when there is any. */
  textPath?: string;
  /** What the file is, e.g. "PDF, 12 pages". */
  summary?: string;
  /** Where a fetched link came from. */
  url?: string;
}

/**
 * The paths an upload is materialized at. The id prefix keeps two files of
 * the same name apart; the name stays readable for the model and the person.
 */
export function attachmentPaths(uploadId: string, name: string): { file: string; text: string } {
  const dir = `${ATTACHMENTS_DIR}/${uploadId.slice(0, 8)}`;
  return { file: `${dir}/${name}`, text: `${dir}/${name}.txt` };
}

/**
 * Splits a stored message into what to show and what to tag.
 *
 * A block it cannot parse is left in the text rather than dropped: showing
 * something ugly beats silently hiding what the model was actually told.
 */
export function parseAttachmentManifest(message: string): {
  text: string;
  attachments: MessageAttachment[];
} {
  const at = message.indexOf(ATTACHMENTS_MARKER);
  if (at === -1) return { text: message, attachments: [] };

  const json = message
    .slice(at + ATTACHMENTS_MARKER.length)
    .split("\n")
    .find((line) => line.startsWith("[") && line.endsWith("]"));

  try {
    const parsed: unknown = JSON.parse(json ?? "");
    if (!Array.isArray(parsed)) return { text: message, attachments: [] };
    return {
      text: message.slice(0, at).trimEnd(),
      attachments: parsed.filter(isMessageAttachment),
    };
  } catch {
    return { text: message, attachments: [] };
  }
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.name === "string" &&
    typeof a.size === "number" &&
    typeof a.type === "string" &&
    (typeof a.uploadId === "string" || a.uploadId === null)
  );
}

/**
 * The hard ceiling on inlined attachment text in one message, whatever the
 * window. A message travels as one WebSocket frame (1 MB), and past a few
 * hundred thousand characters the excerpt-plus-file route reads better anyway.
 */
export const MAX_INLINE_ATTACHMENT_CHARS = 600_000;

/**
 * How many tokens of attachment text one message may inline, for a model
 * with this context window.
 *
 * A fifth of the window: enough that a typical document arrives whole, and
 * little enough that the conversation, the tools and the answer still fit
 * well under the line where the session folds its context
 * (`CONTEXT_HANDOVER_RATIO`). Small windows get at least 8k so a short file
 * is never excerpted for nothing; an unknown window is treated as a modest
 * 128k model. What does not fit is read from `.attachments/` instead.
 */
export function attachmentBudgetTokens(windowTokens: number | null | undefined): number {
  const window = windowTokens && windowTokens > 0 ? windowTokens : 128_000;
  const tokens = Math.floor(window * 0.2);
  return Math.max(8_000, Math.min(tokens, Math.floor(MAX_INLINE_ATTACHMENT_CHARS / CHARS_PER_TOKEN)));
}

/**
 * Shares a character budget between several texts: each gets what it needs
 * if it can, smallest first, and the long ones split what is left. So three
 * short files and one long one inline the short ones whole and excerpt only
 * the long one, rather than cutting every file to a quarter.
 */
export function allocateBudget(lengths: readonly number[], budget: number): number[] {
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length);
  const out = new Array<number>(lengths.length).fill(0);
  let remaining = Math.max(0, budget);
  order.forEach(({ length, index }, i) => {
    const fair = Math.floor(remaining / (order.length - i));
    const given = Math.min(length, fair);
    out[index] = given;
    remaining -= given;
  });
  return out;
}

/**
 * The start of a long text, cut at a line break near the limit so a table
 * row or sentence is not split mid-way.
 */
export function excerpt(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.lastIndexOf("\n", chars);
  return text.slice(0, cut > chars * 0.8 ? cut : chars);
}

/** The http(s) URLs in a piece of text, deduplicated, in order. */
export function findLinks(text: string, max = 5): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    // Sentence punctuation that trails a pasted link is not part of it.
    const url = match[0].replace(/[.,;:!?]+$/, "");
    try {
      found.add(new URL(url).href);
    } catch {
      continue;
    }
    if (found.size >= max) break;
  }
  return [...found];
}

/**
 * Inlined attachment text at or past this size is taken out of a message
 * once it is no longer one of the newest (`elideInlinedAttachments`). Below
 * it, keeping the message byte-identical is worth more: the prompt cache.
 */
export const ELIDE_INLINE_CHARS = 16_000;

/**
 * A message as an older turn of the conversation carries it: the typed text
 * and the manifest, without the files' inlined text, which the model already
 * read and which is still in `.attachments/` at the paths the manifest names.
 * Returns the message unchanged when there is little to save.
 */
export function elideInlinedAttachments(message: string): string {
  const at = message.indexOf(ATTACHMENTS_MARKER);
  if (at === -1) return message;
  const lines = message.slice(at).split("\n");
  const manifest = lines.findIndex((line) => line.startsWith("[") && line.endsWith("]"));
  if (manifest === -1) return message;
  const head = message.slice(0, at) + lines.slice(0, manifest + 1).join("\n");
  const rest = message.slice(head.length);
  const inline = rest.indexOf("\n\n--- ");
  if (inline === -1 || rest.length - inline < ELIDE_INLINE_CHARS) return message;
  return (
    head +
    rest.slice(0, inline) +
    "\n\n(The files' text was inlined here when this message was sent and has been taken out to save context. " +
    "Read it again from the `textPath` or `path` in the manifest above if you need it.)"
  );
}
