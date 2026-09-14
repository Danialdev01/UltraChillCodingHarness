/**
 * A question about one place in the code, from the editor's `:chat`.
 *
 * `from` and `to` are 1-based, inclusive, the way line numbers read in the
 * gutter -- and the way the agent will quote them back.
 */
export interface CodeReference {
  path: string;
  from: number;
  to: number;
}

/** `:chat` over a selection: the lines in gutter order, whichever end was the head. */
export function codeReference(path: string, a: number, b: number): CodeReference {
  return { path, from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * What the agent is actually sent: where to look, then what to do there.
 *
 * "refer line 12 inside file src/app.ts, rename this" -- the location comes
 * first so the model reads the code before the instruction, and a span is
 * written as a range so a selection of several lines is not mistaken for one.
 */
export function codeChatPrompt(ref: CodeReference, command: string): string {
  const lines = ref.from === ref.to ? `line ${ref.from}` : `line ${ref.from}-${ref.to}`;
  return `refer ${lines} inside file ${ref.path}, ${command.trim()}`;
}
