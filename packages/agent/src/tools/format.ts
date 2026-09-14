/**
 * Shared formatting for tool results.
 *
 * Every tool returns a string, and two properties matter for all of them:
 * it is never empty, because several providers reject an empty tool result
 * outright, and it is never unbounded, because one `bash` producing 40 MB
 * would otherwise blow the context window for the rest of the turn.
 */

/** Roughly what a tool result may occupy. Generous, but finite. */
export const DEFAULT_CLAMP_BYTES = 30_000;

/**
 * Keeps the head and the tail, eliding the middle.
 *
 * Both ends earn their place: a build's first error is at the top and its
 * summary is at the bottom, and keeping only one of the two regularly throws
 * away the half that answered the question. The marker is explicit so the
 * model knows it is looking at a gap rather than the whole output.
 */
export function clamp(text: string, maxBytes: number = DEFAULT_CLAMP_BYTES): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;

  const head = Math.floor(maxBytes * 0.7);
  const tail = maxBytes - head;
  const elided = buffer.length - maxBytes;

  // A slice can land inside a UTF-8 sequence; one replacement character at
  // the seam is a fair price for an exact byte bound.
  return (
    buffer.subarray(0, head).toString("utf8") +
    `\n\n… ${elided.toLocaleString("en-US")} bytes elided …\n\n` +
    buffer.subarray(buffer.length - tail).toString("utf8")
  );
}

/**
 * `cat -n`, right-aligned to the widest number in the range.
 *
 * Line numbers are what make `edit_file` usable: without them the model
 * cannot say where it is looking, and it cannot check that an edit landed.
 */
export function numberLines(lines: readonly string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(firstLine + i).padStart(width)}\t${line}`).join("\n");
}

/** Guesses a language for the UI's syntax highlighting. Never sent to the model. */
export function languageOf(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES[extension];
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  php: "php",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  toml: "toml",
};

/** Turns a thrown value into something a model can act on. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
