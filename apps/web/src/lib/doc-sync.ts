/**
 * The smallest single edit that turns one text into another.
 *
 * For pushing a file the agent rewrote into an editor that is showing it:
 * replacing the whole document would work, but it would also drop the cursor
 * to the top and the scroll with it. Trimming the common prefix and suffix
 * leaves one span to replace, so an edit elsewhere in the file leaves your
 * place alone. Null when the texts are already the same.
 */
export function replacement(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null

  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++

  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--
    endAfter--
  }

  return { from: start, to: endBefore, insert: after.slice(start, endAfter) }
}
