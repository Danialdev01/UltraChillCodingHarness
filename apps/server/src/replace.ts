import { SearchError, type SearchOptions } from "./search.js";

/**
 * Replacing what the search sidebar found.
 *
 * The browser sends back the matches it was shown and the user left ticked --
 * a line and a character range each -- and only those are replaced. Nothing
 * is searched for afresh and replaced wholesale: what changes is exactly what
 * the user saw and agreed to, and nothing that appeared since.
 *
 * Each range is checked against the file as it is now before it is touched.
 * The pattern must still match there, starting and ending at the same place;
 * if it does not, the line moved or changed after the search, and that match
 * is reported stale rather than guessed at.
 */

/** One ticked match: a 1-based line and a character range within it. */
export interface ReplaceTarget {
  line: number;
  start: number;
  end: number;
}

export interface ReplaceOutcome {
  content: string;
  /** How many of the targets were replaced. */
  replaced: number;
  /** How many no longer matched where the search had found them. */
  stale: number;
}

/**
 * The search as a JavaScript pattern, to check and replace matches with.
 *
 * Sticky, so a match is tried at one offset and only there. Unicode where the
 * pattern allows it, for the same case folding ripgrep does; a pattern that
 * only parses without it still works, as it did in ripgrep.
 */
export function compilePattern(options: Pick<SearchOptions, "query" | "caseSensitive" | "regex">): RegExp {
  const source = options.regex ? options.query : escapeRegExp(options.query);
  const flags = options.caseSensitive ? "y" : "iy";
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (error) {
      throw new SearchError(error instanceof Error ? error.message : String(error), true);
    }
  }
}

/**
 * Replaces the targets in a file's content.
 *
 * In a regular-expression search the replacement may refer to groups (`$1`,
 * `$<name>`, `$&`); in a literal one it is inserted as it was typed, so a `$`
 * in it is a dollar sign.
 *
 * Line endings are kept as each line has them. Every replacement on a line is
 * worked out against the line as it was, then spliced in from the right, so
 * one replacement never moves the offsets of the next.
 */
export function applyReplacements(
  content: string,
  pattern: RegExp,
  replacement: string,
  targets: readonly ReplaceTarget[],
  regex: boolean,
): ReplaceOutcome {
  const byLine = new Map<number, ReplaceTarget[]>();
  for (const target of targets) {
    const list = byLine.get(target.line) ?? [];
    list.push(target);
    byLine.set(target.line, list);
  }

  // Each line with its own terminator, so the file is rebuilt byte for byte.
  const lines = content.split(/(?<=\n)/);
  let replaced = 0;
  let stale = 0;

  for (const [lineNumber, lineTargets] of byLine) {
    const raw = lines[lineNumber - 1];
    if (raw === undefined) {
      stale += lineTargets.length;
      continue;
    }
    const ending = /\r?\n$/.exec(raw)?.[0] ?? "";
    const text = raw.slice(0, raw.length - ending.length);

    const splices: Array<{ start: number; end: number; with: string }> = [];
    const seen = new Set<number>();
    for (const { start, end } of lineTargets) {
      if (seen.has(start) || !matchesAt(pattern, text, start, end)) {
        stale += 1;
        continue;
      }
      seen.add(start);
      splices.push({ start, end, with: regex ? expandAt(pattern, text, start, end, replacement) : replacement });
    }

    let next = text;
    for (const splice of splices.sort((a, b) => b.start - a.start)) {
      next = next.slice(0, splice.start) + splice.with + next.slice(splice.end);
      replaced += 1;
    }
    lines[lineNumber - 1] = next + ending;
  }

  return { content: lines.join(""), replaced, stale };
}

/** Whether the pattern, tried at `start`, matches exactly up to `end`. */
function matchesAt(pattern: RegExp, text: string, start: number, end: number): boolean {
  if (start < 0 || end <= start || end > text.length) return false;
  pattern.lastIndex = start;
  const found = pattern.exec(text);
  return found !== null && found.index === start && found.index + found[0].length === end;
}

/**
 * The replacement for the match at `start`, with its groups filled in.
 *
 * `String.replace` does the expansion, on the whole line so anchors and
 * lookarounds see the context the search saw; the replaced piece is then cut
 * back out of the result.
 */
function expandAt(pattern: RegExp, text: string, start: number, end: number, replacement: string): string {
  pattern.lastIndex = start;
  const out = text.replace(pattern, replacement);
  return out.slice(start, out.length - (text.length - end));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
