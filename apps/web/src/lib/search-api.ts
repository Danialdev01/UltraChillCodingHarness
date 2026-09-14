/**
 * Searching a project's files, over the API.
 *
 * The search itself is ripgrep on the server, inside the project's workspace.
 * Nothing is indexed here or there, so what comes back reflects the files as
 * they are now -- including whatever the agent wrote a second ago.
 */

/** Where one match sits inside its line, as character offsets. */
export type MatchRange = [start: number, end: number];

export interface SearchMatch {
  path: string;
  /** 1-based, as every editor counts. */
  line: number;
  text: string;
  ranges: MatchRange[];
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when the server's cap cut the list short of what was found. */
  truncated: boolean;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  /** An abort signal, so a superseded search is cancelled rather than raced. */
  signal?: AbortSignal;
}

/**
 * Runs one search.
 *
 * The query goes in the URL because this is a read, and because aborting the
 * fetch is then the whole of cancelling it -- which the panel does on every
 * keystroke that supersedes a search already in flight.
 */
export async function searchFiles(
  hash: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query });
  if (options.caseSensitive) params.set("case", "1");
  if (options.regex) params.set("regex", "1");

  const response = await fetch(`/api/projects/${hash}/search?${params}`, {
    credentials: "include",
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "The search could not be run.");
  }
  return (await response.json()) as SearchResult;
}

/** One file's matches, in the order the file has them. */
export interface SearchGroup {
  path: string;
  matches: SearchMatch[];
}

/**
 * Matches grouped by file, keeping the order they arrived in.
 *
 * ripgrep reports file by file already, so this preserves that rather than
 * sorting: its order is roughly directory order, which is the order the tree
 * beside it is in.
 */
export function groupByFile(matches: readonly SearchMatch[]): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const match of matches) {
    const last = groups[groups.length - 1];
    if (last && last.path === match.path) last.matches.push(match);
    else groups.push({ path: match.path, matches: [match] });
  }
  return groups;
}

/**
 * A line split into the parts that matched and the parts that did not.
 *
 * Returned as segments rather than as HTML: the panel renders them as elements,
 * so a line of code containing angle brackets is text and never markup.
 *
 * Leading whitespace is trimmed off the front of the line, and the ranges move
 * with it -- indented code would otherwise push every match off the right of an
 * eighteen-rem panel.
 */
export function highlight(
  text: string,
  ranges: readonly MatchRange[],
): Array<{ text: string; match: boolean }> {
  const indent = text.length - text.trimStart().length;
  const trimmed = text.slice(indent);

  const segments: Array<{ text: string; match: boolean }> = [];
  let at = 0;

  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(0, rawStart - indent);
    const end = Math.max(0, rawEnd - indent);
    // A match inside the indentation, or one arriving out of order, is skipped
    // rather than allowed to produce a negative slice.
    if (end <= start || start < at || start >= trimmed.length) continue;
    if (start > at) segments.push({ text: trimmed.slice(at, start), match: false });
    segments.push({ text: trimmed.slice(start, end), match: true });
    at = end;
  }

  if (at < trimmed.length) segments.push({ text: trimmed.slice(at), match: false });
  return segments;
}
