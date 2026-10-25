/**
 * Runs `callback` at most once a frame, however many times it is asked for:
 * what streams in faster than the screen redraws -- tokens, a replay -- is
 * drawn once per frame rather than once per event.
 *
 * The first request in a frame runs at once, as a task of its own, so the
 * render it causes overlaps the wait for the next frame rather than
 * starting at it: a lone update paints as soon as it would have without
 * any batching. Requests after that wait for the next frame.
 *
 * A hidden tab gets no animation frames, so a 100 ms timer races the frame
 * and whichever comes first runs it: the state behind a hidden tab keeps up
 * without drawing. Outside a browser (tests, the server render) frames are
 * timers too.
 */
export function frameBatcher(callback: () => void): { schedule(): void; cancel(): void } {
  let frame: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Already ran in this frame; cleared when the next one starts. */
  let spent = false
  let cancelReset: (() => void) | null = null

  const cancelPending = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
    frame = null
    timer = null
  }
  const nextFrame = (then: () => void): (() => void) => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(then)
      return () => cancelAnimationFrame(id)
    }
    const id = setTimeout(then, FRAME_MS)
    return () => clearTimeout(id)
  }
  const run = () => {
    cancelPending()
    spent = true
    cancelReset ??= nextFrame(() => {
      cancelReset = null
      spent = false
    })
    callback()
  }

  return {
    schedule() {
      if (frame !== null || timer !== null) return
      if (!spent) {
        timer = setTimeout(run, 0)
        return
      }
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run)
      timer = setTimeout(run, HIDDEN_FALLBACK_MS)
    },
    cancel() {
      cancelPending()
      cancelReset?.()
      cancelReset = null
      spent = false
    },
  }
}

/** How long a tab without animation frames waits before the batch runs anyway. */
export const HIDDEN_FALLBACK_MS = 100

/** A frame, where there are no animation frames to count. */
const FRAME_MS = 16
