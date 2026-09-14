/**
 * The words and numbers on the line that says a turn is working.
 *
 * Pure, because the interesting parts are: a clock that has to read sensibly
 * at four seconds and at four hours, and a word that has to look random
 * without ever changing on a render it did not mean to.
 */

/**
 * What the harness calls thinking.
 *
 * All gerunds so the line reads the same however it lands, and deliberately
 * unserious: this sits under a spinner for minutes at a time, and a rotating
 * word is what tells the reader at a glance that something is still moving.
 */
export const WORKING_WORDS: readonly string[] = [
  "Thinking",
  "Pondering",
  "Noodling",
  "Percolating",
  "Simmering",
  "Cogitating",
  "Puzzling",
  "Tinkering",
  "Brewing",
  "Conjuring",
  "Ruminating",
  "Mulling",
  "Scheming",
  "Wrangling",
  "Finagling",
  "Marinating",
  "Spelunking",
  "Untangling",
  "Whirring",
  "Deliberating",
  "Contemplating",
  "Rummaging",
  "Assembling",
  "Distilling",
  "Unpicking",
  "Chewing",
  "Plotting",
  "Reticulating",
];

/**
 * The word for a given turn at a given step.
 *
 * Indexed rather than drawn at random, so the same turn and step always give
 * the same word: a word picked inside a render would change on every keypress
 * elsewhere in the page, which reads as a glitch rather than as progress.
 * The turn id offsets the sequence so two turns in a row do not open on the
 * same word.
 */
export function workingWord(turnId: string, step: number): string {
  let seed = 0;
  for (const character of turnId) seed = (seed * 31 + character.charCodeAt(0)) % 100_000;
  const index = (seed + step) % WORKING_WORDS.length;
  return WORKING_WORDS[index]!;
}

/** How long a word stays before the next one. */
export const WORD_INTERVAL_MS = 8_000;

/**
 * Elapsed time, in the units a person would say it.
 *
 * Seconds alone below a minute, then minutes and seconds, then hours and
 * minutes -- at which point the seconds are noise. Never negative: a clock
 * that ran backwards for a frame would be more alarming than the wait.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A token count, shortened.
 *
 * Its own rather than the dashboard's, because this one is an estimate and a
 * decimal past a thousand would claim a precision it does not have.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  const thousands = tokens / 1000;
  return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}
