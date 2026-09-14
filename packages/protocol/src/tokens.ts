/**
 * The one token estimate.
 *
 * Four characters to a token: a rough average for English and code, and
 * deliberately a heuristic rather than a tokenizer. Two reasons. A real
 * tokenizer is per-model, and this harness talks to whatever the catalogue
 * offers; and the number is wanted in places where an exact answer is not
 * available anyway -- mid-stream in the UI, and before a request has been
 * sent at all.
 *
 * It lives here, in the package both halves already depend on, because the
 * server decides when to compact and the composer draws the meter, and the
 * two disagreeing about how full a thread is would be a bug that looks like
 * a rendering glitch.
 */
export const CHARS_PER_TOKEN = 4;

/** Roughly how many tokens a given number of characters weighs. */
export function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}
