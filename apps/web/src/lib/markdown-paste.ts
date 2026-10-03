/**
 * Whether pasted plain text is markdown worth parsing as such.
 *
 * Only block syntax counts -- a heading, a list, a fence, a quote, a rule or
 * a table row at the start of a line. Inline marks are handled by the
 * editor's own paste rules, and a sentence that happens to contain an
 * asterisk should stay the sentence it was.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.includes("\n") && !/^(#{1,6} |[-*+] |\d+\. |> |```)/.test(text)) return false;
  return /^(#{1,6} |[-*+] |\d+\. |> |```|---\s*$|\|.*\|)/m.test(text);
}
