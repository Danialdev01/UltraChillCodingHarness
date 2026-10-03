/**
 * A page as a `.md` file, and back.
 *
 * The title is a field outside the document, so it travels as a leading
 * `# Heading` -- which is also what a file written elsewhere puts first.
 */

import { titleOrUntitled } from "./note-tree";

/** A filename the OS will take, from a title it may not. */
export function markdownFileName(title: string): string {
  const base = titleOrUntitled(title)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || "Untitled"}.md`;
}

/** The exported text: the title as a heading, then the body. */
export function markdownWithTitle(title: string, body: string): string {
  const heading = title.trim() ? `# ${title.trim()}\n\n` : "";
  return heading + body.replace(/^\n+/, "");
}

/**
 * A leading `# Heading` split off as the title, when there is one. The body
 * keeps everything else as it was.
 */
export function splitMarkdownTitle(markdown: string): { title: string | null; body: string } {
  const match = markdown.match(/^﻿?\s*# +(.+?)[ \t]*\n+/);
  if (!match) return { title: null, body: markdown };
  return { title: match[1]!.trim(), body: markdown.slice(match[0].length) };
}
