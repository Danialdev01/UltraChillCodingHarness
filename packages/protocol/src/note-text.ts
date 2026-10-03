/**
 * A note's body as plain text, for searching.
 *
 * The document is ProseMirror JSON; searching the JSON itself would match
 * node names and attributes, and a whiteboard snapshot in full. This walks
 * it for the words a reader sees -- text, captions, diagram source -- and
 * nothing else. Shared by the server, which stores the result beside the
 * body, and the web app, which shows the snippet around a match.
 */

import type { NoteDoc } from "./notes.js";

/** The most text a page contributes to search; anything past it is noise. */
export const NOTE_TEXT_MAX = 200_000;

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

/** Attributes whose value is what the block says, block by block. */
const TEXT_ATTRS: Record<string, readonly string[]> = {
  image: ["caption", "alt"],
  mermaid: ["code"],
  embed: ["original"],
};

export function noteText(doc: NoteDoc): string {
  const blocks: string[] = [];
  let size = 0;
  const walk = (node: unknown): void => {
    if (size >= NOTE_TEXT_MAX || !node || typeof node !== "object") return;
    const n = node as JsonNode;
    if (typeof n.text === "string") {
      blocks.push(n.text);
      size += n.text.length;
      return;
    }
    for (const attr of TEXT_ATTRS[n.type ?? ""] ?? []) {
      const value = n.attrs?.[attr];
      if (typeof value === "string" && value.trim()) {
        blocks.push(value, "\n");
        size += value.length;
      }
    }
    if (!Array.isArray(n.content)) return;
    for (const child of n.content) {
      walk(child);
      // Blocks read as separate lines; inline runs join into one.
      if (isBlock(child)) blocks.push("\n");
    }
  };
  walk(doc);
  return blocks
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, NOTE_TEXT_MAX);
}

function isBlock(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const type = (node as JsonNode).type;
  return typeof type === "string" && type !== "text" && !INLINE.has(type);
}

const INLINE = new Set(["hardBreak", "mention", "emoji"]);

/**
 * The text around the first match of `query`, trimmed to `radius` on each
 * side, on one line. The start of the text when nothing matches.
 */
export function snippetAround(text: string, query: string, radius = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const q = query.trim().toLowerCase();
  const at = q ? flat.toLowerCase().indexOf(q) : -1;
  if (at === -1) return ellipsize(flat.slice(0, radius * 2), flat.length > radius * 2, false);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + q.length + radius);
  return ellipsize(flat.slice(start, end), end < flat.length, start > 0);
}

function ellipsize(text: string, after: boolean, before: boolean): string {
  return `${before ? "…" : ""}${text.trim()}${after ? "…" : ""}`;
}
