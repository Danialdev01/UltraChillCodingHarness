import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { frameBatcher, HIDDEN_FALLBACK_MS } from "./next-frame"

describe("frameBatcher", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** Animation frames that run only when the test says a frame has come. */
  function frames() {
    let queued: Array<() => void> = []
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      queued.push(callback)
      return queued.length
    })
    vi.stubGlobal("cancelAnimationFrame", () => {})
    return () => {
      const due = queued
      queued = []
      for (const callback of due) callback()
    }
  }

  it("runs the first request of a frame at once, as its own task", () => {
    frames()
    const run = vi.fn()
    const batch = frameBatcher(run)
    batch.schedule()
    batch.schedule()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("holds the rest of the frame's requests for the next frame", () => {
    const frame = frames()
    const run = vi.fn()
    const batch = frameBatcher(run)
    batch.schedule()
    vi.advanceTimersByTime(0)
    batch.schedule()
    batch.schedule()
    vi.advanceTimersByTime(10)
    expect(run).toHaveBeenCalledTimes(1)
    frame()
    expect(run).toHaveBeenCalledTimes(2)
    // A fresh frame: its first request goes at once again.
    frame()
    batch.schedule()
    vi.advanceTimersByTime(0)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("runs anyway in a tab that gets no frames", () => {
    frames()
    const run = vi.fn()
    const batch = frameBatcher(run)
    batch.schedule()
    vi.advanceTimersByTime(0)
    batch.schedule()
    vi.advanceTimersByTime(HIDDEN_FALLBACK_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("runs nothing once cancelled", () => {
    frames()
    const run = vi.fn()
    const batch = frameBatcher(run)
    batch.schedule()
    batch.cancel()
    vi.advanceTimersByTime(HIDDEN_FALLBACK_MS)
    expect(run).not.toHaveBeenCalled()
  })
})
