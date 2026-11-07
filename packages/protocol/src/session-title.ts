/**
 * A session's title, read off the first thing said in it.
 *
 * Deterministic rather than asked of a model: the engine projects it from
 * the `user.message` event in the same transaction, so a replayed log
 * produces the same titles, and nothing waits on a second LLM call (or
 * bills one) before the sidebar can say what the session is about.
 */

/** The names a session is born with, which its first message replaces. */
export const PLACEHOLDER_TITLES: readonly string[] = ["Untitled", "New session"];

export const SESSION_TITLE_MAX = 60;

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return t === "" || PLACEHOLDER_TITLES.includes(t);
}

/**
 * The title for a session whose first message is `text`, or null when the
 * message says nothing a title could be made of (only an image, only code).
 *
 * The first line with words in it, with markdown, mentions and attached
 * blocks stripped, cut at a word boundary to {@link SESSION_TITLE_MAX}
 * characters, its first letter capitalised.
 */
export function titleFromPrompt(text: string): string | null {
  const cleaned = text
    // Fenced code and attached blocks (`<file …>…</file>`) say what the
    // message is about less well than the sentence around them.
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw
      // A slash command opening the message: `/plan fix the build`.
      .replace(/^\s*\/[\w:-]+\s*/, "")
      // Headings, quotes, list markers.
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      // `@path/to/file.ts` reads as the file's name.
      .replace(/@([\w./-]+)/g, (_m, path: string) => path.split("/").pop() ?? path)
      // [label](url) -> label; emphasis and inline code markers.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    return capitalise(shorten(line.replace(/[\s.:;,!-]+$/, "")));
  }
  return null;
}

function shorten(line: string): string {
  if (line.length <= SESSION_TITLE_MAX) return line;
  const cut = line.slice(0, SESSION_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  // A long first word is cut where it stands rather than leaving one letter.
  return `${(space > SESSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s.:;,!-]+$/, "")}…`;
}

function capitalise(line: string): string {
  return line.charAt(0).toLocaleUpperCase() + line.slice(1);
}
