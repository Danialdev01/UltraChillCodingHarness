/**
 * A terminal's output as React state: the newest chunks, plus how many have
 * ever arrived.
 *
 * `chunks` is capped, so its length stops growing once full and cannot say
 * what is new. `total` keeps counting, which is how `XtermPane` knows which
 * chunks it has not written yet.
 */
export interface TerminalOutput {
  chunks: readonly string[]
  total: number
}

export const EMPTY_OUTPUT: TerminalOutput = { chunks: [], total: 0 }

/** Appends, keeping at most `max` chunks. */
export function appendOutput(
  output: TerminalOutput,
  chunks: readonly string[],
  max: number,
): TerminalOutput {
  if (chunks.length === 0) return output
  return {
    chunks: [...output.chunks, ...chunks].slice(-max),
    total: output.total + chunks.length,
  }
}

/**
 * Collects pushed items and hands them over about once a frame.
 *
 * A busy build prints hundreds of chunks a second; one React update per
 * chunk is what made a chatty terminal lag the whole page. A timer rather
 * than `requestAnimationFrame`, which never fires in a background tab and
 * would let a long build pile up there unflushed.
 */
export function frameBatcher<T>(flush: (items: T[]) => void): {
  push: (item: T) => void
  cancel: () => void
} {
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    push(item) {
      pending.push(item)
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        const items = pending
        pending = []
        flush(items)
      }, 16)
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}
