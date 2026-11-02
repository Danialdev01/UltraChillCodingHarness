/**
 * Searching a project's files, over the API.
 *
 * The search itself is ripgrep on the server, inside the project's workspace.
 * Nothing is indexed here or there, so what comes back reflects the files as
 * they are now -- including whatever the agent wrote a second ago.
 */

import { projectApiUrl, type ProjectTarget } from "./project-target";

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
  target: ProjectTarget,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const params: Record<string, string> = { q: query };
  if (options.caseSensitive) params.case = "1";
  if (options.regex) params.regex = "1";

  // Through the target, so a session's search is of its own worktree -- the
  // tree a replace from these results would write to.
  const response = await fetch(projectApiUrl(target, "search", params), {
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

/** A match's identity, for the set of ticked ones: its file, line and where it starts. */
export function matchKey(path: string, line: number, start: number): string {
  return `${path}\u0000${line}\u0000${start}`;
}

/** Every match in the results, ticked -- which is how a new search starts. */
export function allKeys(matches: readonly SearchMatch[]): Set<string> {
  const keys = new Set<string>();
  for (const match of matches) {
    for (const [start] of match.ranges) keys.add(matchKey(match.path, match.line, start));
  }
  return keys;
}

export interface ReplaceRequest {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  replacement: string;
  files: Array<{ path: string; matches: Array<{ line: number; start: number; end: number }> }>;
}

/**
 * The ticked matches, file by file, as the replace request names them.
 * A file with nothing ticked is left out altogether.
 */
export function selectionBody(
  groups: readonly SearchGroup[],
  selected: ReadonlySet<string>,
): ReplaceRequest["files"] {
  const files: ReplaceRequest["files"] = [];
  for (const group of groups) {
    const matches = [];
    for (const match of group.matches) {
      for (const [start, end] of match.ranges) {
        if (selected.has(matchKey(match.path, match.line, start))) matches.push({ line: match.line, start, end });
      }
    }
    if (matches.length > 0) files.push({ path: group.path, matches });
  }
  return files;
}

export interface ReplaceResult {
  /** Occurrences replaced. */
  replaced: number;
  /** Files written. */
  files: number;
  /** Files, or matches in them, left as they were, and why. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Replaces the ticked matches.
 *
 * The server checks each one against the file as it is now, so a line that
 * changed since the search is reported rather than overwritten.
 */
export async function replaceInFiles(target: ProjectTarget, body: ReplaceRequest): Promise<ReplaceResult> {
  const response = await fetch(projectApiUrl(target, "replace"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "The replace could not be made.");
  }
  return (await response.json()) as ReplaceResult;
}

export type PreviewSegment = { text: string; kind: "text" | "match" | "removed" | "inserted" };

/**
 * A line as it will read after the replace: each ticked match struck through
 * with its replacement beside it, an unticked one highlighted as a plain
 * match. Indentation is trimmed the way `highlight` trims it.
 *
 * In a regular-expression search the replacement is shown as typed, `$1` and
 * all; the server fills the groups in.
 */
export function previewSegments(
  text: string,
  ranges: readonly MatchRange[],
  isTicked: (start: number) => boolean,
  replacement: string,
): PreviewSegment[] {
  const indent = text.length - text.trimStart().length;
  const trimmed = text.slice(indent);

  const segments: PreviewSegment[] = [];
  let at = 0;

  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(0, rawStart - indent);
    const end = Math.max(0, rawEnd - indent);
    if (end <= start || start < at || start >= trimmed.length) continue;
    if (start > at) segments.push({ text: trimmed.slice(at, start), kind: "text" });
    const matched = trimmed.slice(start, end);
    if (isTicked(rawStart)) {
      segments.push({ text: matched, kind: "removed" });
      if (replacement) segments.push({ text: replacement, kind: "inserted" });
    } else {
      segments.push({ text: matched, kind: "match" });
    }
    at = end;
  }

  if (at < trimmed.length) segments.push({ text: trimmed.slice(at), kind: "text" });
  return segments;
}
