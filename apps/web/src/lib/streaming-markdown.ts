/**
 * Where a streaming answer can be cut in two: before it, text that is done
 * changing as Markdown; after it, the tail that is still being written.
 *
 * The cut is at the start of a line that follows a blank line outside any
 * code fence, and does not itself begin with whitespace: there a new
 * top-level block begins, so the two halves parse as they would together.
 * An indented line after a blank one could be a list item's second
 * paragraph, or code; the cut waits for a line that is neither. 0 when
 * there is no such place yet -- the whole answer is the tail.
 *
 * Linear in the text, which is cheap beside the parse it saves: the prefix
 * goes through the memoised `Markdown` and is parsed once, not again on
 * every token.
 */
export function streamingCut(text: string): number {
  let cut = 0;
  let fence: string | null = null;
  let afterBlank = false;
  let at = 0;
  while (at < text.length) {
    const found = text.indexOf("\n", at);
    // The last line, still being written, counts once its first character
    // is there: that alone says whether a new block starts with it.
    const end = found < 0 ? text.length : found;
    const line = text.slice(at, end);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (afterBlank && line.length > 0 && !/^\s/.test(line)) cut = at;
      if (marker) fence = marker;
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
    afterBlank = fence === null && line.trim() === "";
    at = end + 1;
  }
  return cut;
}
