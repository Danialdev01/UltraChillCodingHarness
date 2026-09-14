/**
 * Where the reader is in the thread, and where they can go from here.
 *
 * Two things the chat needs to know about its own scroll box: whether the
 * reader is still at the bottom -- which decides whether a streaming reply
 * carries them along or leaves them where they scrolled to -- and which
 * prompts sit before and after the one they are looking at, for the arrows
 * that walk between them.
 */

/**
 * How close to the floor counts as being on it, in pixels.
 *
 * Not zero: a smooth scroll settles a fraction short, a sub-pixel layout
 * rounds the other way, and a reader who has scrolled up two lines has not
 * left the conversation. Anything past a line or two has.
 */
export const BOTTOM_SLACK = 48;

/** The three numbers a scroll box reports, named so a test can hand them over. */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** True when the box is scrolled to, or nearly to, its floor. */
export function atBottom(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK;
}

/**
 * The prompts either side of each prompt, by position in the message list.
 *
 * Keyed by the index of the user message in `messages`, and pointing at the
 * indexes of the user messages before and after it -- the replies in between
 * are skipped, because the arrows walk questions, not turns. The first has no
 * previous and the last no next; the arrows are drawn disabled rather than
 * hidden, so a thread with one prompt still shows where they will be.
 */
export interface PromptNeighbours {
  previous: number | null;
  next: number | null;
}

export function promptNeighbours(
  messages: readonly { role: string }[],
): ReadonlyMap<number, PromptNeighbours> {
  const prompts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") prompts.push(i);
  });
  const out = new Map<number, PromptNeighbours>();
  prompts.forEach((index, n) => {
    out.set(index, { previous: prompts[n - 1] ?? null, next: prompts[n + 1] ?? null });
  });
  return out;
}

/**
 * Whether a message would show the model pictures it cannot see.
 *
 * Only the native loop is checked: the CLI harnesses pick from a short list
 * of models that all take images, and their catalogue does not say either
 * way. On OpenRouter the catalogue does, and the honest thing is to say so
 * before the send rather than let the turn fail with the message in it.
 * `null` for vision, so the caller can check the model's flag is known:
 * a model the catalogue no longer lists is not refused, only unverified.
 */
export function visionWarning(
  imageCount: number,
  model: { name: string; images: boolean } | undefined,
): string | null {
  if (imageCount === 0 || !model || model.images) return null;
  return `${model.name} can't see images. Pick a model with vision, or remove the ${
    imageCount === 1 ? "picture" : "pictures"
  }.`;
}
