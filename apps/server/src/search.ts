import { HostExecutor } from "@ucch/agent";

/**
 * Searching a project's files, for the browser's search sidebar.
 *
 * ripgrep, the same way the agent's own `grep` tool does it -- and for the same
 * reasons: nothing to index, nothing to invalidate, so a repository cloned
 * thirty seconds ago is searchable, and a file the agent rewrote a moment ago
 * is searched as it is now rather than as it was when something last built an
 * index. `.gitignore` is respected, so `node_modules` is not what you find.
 *
 * The difference from the tool is the shape of the answer. The model is given
 * `path:line: text` to read; the sidebar is given structure -- a line, and
 * where in it the match sits -- because it draws the match highlighted and
 * jumps the editor to it.
 */

/** Where one match sits inside its line, as character offsets. */
export type MatchRange = [start: number, end: number];

export interface SearchMatch {
  /** Relative to the workspace root. Absolute paths are an artefact. */
  path: string;
  /** 1-based, as every editor counts. */
  line: number;
  text: string;
  ranges: MatchRange[];
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when the cap stopped the answer short of what ripgrep found. */
  truncated: boolean;
}

export interface SearchOptions {
  query: string;
  /** Lower-cased by default: a keyword search that misses on capitals is a bad one. */
  caseSensitive?: boolean;
  /** Treat the query as a regular expression rather than as literal text. */
  regex?: boolean;
  /** Only search paths matching this glob, e.g. `*.ts`. */
  glob?: string | null;
}

/**
 * Matches in one answer.
 *
 * A sidebar that renders four thousand rows is slower than the search was, and
 * nobody reads past the first screen without narrowing the query anyway. The
 * cap is reported, so the panel can say the list is short rather than implying
 * that is all there is.
 */
export const MAX_SEARCH_MATCHES = 300;

/** The longest a line may be before it is cut. */
const MAX_LINE_LENGTH = 400;

const SEARCH_TIMEOUT_MS = 15_000;

/** Refused before ripgrep is spawned, so an empty box searches for nothing. */
export const MAX_QUERY_LENGTH = 200;

/**
 * The argv for one search.
 *
 * Its own function because the flags carry more meaning than they look like
 * they do, and the ordering carries the safety: `--no-config`
 * first, so a hostile `RIPGREP_CONFIG_PATH` cannot rewrite the flags that
 * follow; and everything after `--` is data, so a query of `--files` searches
 * for that text instead of switching ripgrep into another mode.
 */
export function searchArgv(options: SearchOptions, root: string): string[] {
  const argv = [
    "rg",
    "--no-config",
    "--json",
    "--line-number",
    // Ignore files apply whether or not the directory is a git repository. By
    // default ripgrep reads `.gitignore` only inside a repository, so a project
    // whose clone has not landed yet -- or one started empty before its first
    // commit -- would return every line of `node_modules` and call it a result.
    "--no-require-git",
    // Dotfiles are files: `.github/workflows`, `.env.example`, `.gitignore`
    // itself are all things people search for. `.git` is not -- it is packed
    // objects, and a keyword found in one is noise with no line to open.
    "--hidden",
    "-g",
    "!.git/",
  ];
  // `-F` is what makes this a keyword search rather than a regex one: a query
  // of `config.get(` is four metacharacters, and nobody typing it meant them.
  if (!options.regex) argv.push("--fixed-strings");
  argv.push(options.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (options.glob) argv.push("-g", options.glob);
  argv.push("--", options.query, root);
  return argv;
}

/** Thrown when ripgrep refused the query, which is the caller's to fix. */
export class SearchError extends Error {
  constructor(
    message: string,
    /** False when ripgrep itself is missing, which is the operator's problem. */
    readonly fromQuery: boolean,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

/**
 * Runs one search in a project's workspace.
 *
 * The executor is the agent's own, so the search is confined to exactly the
 * directory the agent's tools are confined to, with the same rebuilt
 * environment and the same timeout discipline. Nothing here resolves a path
 * from the caller: the only directory searched is the workspace root.
 */
export async function searchWorkspace(
  workspace: string,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const executor = new HostExecutor(workspace);
  const root = executor.root();

  let result;
  try {
    result = await executor.exec(searchArgv(options, root), {
      timeoutMs: SEARCH_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing `rg` fails here rather than with an exit code, and it must not
    // read as "no matches" -- that is a silently useless search panel.
    if (message.includes("could not run rg")) {
      throw new SearchError("ripgrep (rg) is not installed on the server.", false);
    }
    throw new SearchError(message, false);
  }

  // 1 is "nothing matched", which is an answer. Anything above it is a refusal.
  if (result.exitCode > 1) {
    throw new SearchError(result.stderr.trim() || "ripgrep could not run that search", true);
  }

  return parseMatches(result.stdout, root);
}

/**
 * Reads ripgrep's `--json` stream into matches.
 *
 * One JSON object per line, of which only `match` events matter here; the
 * `begin`, `end` and `summary` events describe the run rather than the result.
 * A line that will not parse is skipped rather than failing the search: the
 * stream may have been cut by the output cap mid-object, and losing the last
 * match is better than losing all of them.
 *
 * Byte offsets become character offsets. ripgrep counts bytes and the browser
 * counts characters, so a match after a non-ASCII character would otherwise be
 * highlighted in the wrong place -- which is exactly the case nobody tests.
 */
export function parseMatches(stdout: string, root: string): SearchResult {
  const matches: SearchMatch[] = [];
  let truncated = false;
  const prefix = root.endsWith("/") ? root : `${root}/`;

  for (const line of stdout.split("\n")) {
    if (!line) continue;

    let event: RgEvent;
    try {
      event = JSON.parse(line) as RgEvent;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;

    if (matches.length >= MAX_SEARCH_MATCHES) {
      truncated = true;
      break;
    }

    const data = event.data;
    const path = data?.path?.text;
    const raw = data?.lines?.text;
    if (!data || typeof path !== "string" || typeof raw !== "string") continue;

    const text = raw.replace(/\r?\n$/, "");
    const bytes = Buffer.from(text, "utf8");

    const ranges: MatchRange[] = [];
    for (const submatch of data.submatches ?? []) {
      if (typeof submatch?.start !== "number" || typeof submatch?.end !== "number") continue;
      const start = charOffset(bytes, submatch.start);
      const end = charOffset(bytes, submatch.end);
      if (end > start) ranges.push([start, end]);
    }

    matches.push({
      path: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      line: data.line_number ?? 0,
      // Cut rather than dropped: a minified bundle is one 200 KB line, and the
      // match in it is still worth reporting.
      text: text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) : text,
      // A range past the cut would highlight nothing, or throw at the slice.
      ranges: ranges.filter(([, end]) => end <= MAX_LINE_LENGTH),
    });
  }

  return { matches, truncated };
}

/** How many characters precede a byte offset in this line. */
function charOffset(bytes: Buffer, byteOffset: number): number {
  const clamped = Math.max(0, Math.min(byteOffset, bytes.length));
  return bytes.subarray(0, clamped).toString("utf8").length;
}

interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number; end?: number }>;
  };
}
