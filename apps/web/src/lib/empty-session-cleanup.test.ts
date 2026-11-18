import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keepSession, removeWhenLeft } from "./empty-session-cleanup"

describe("leaving an unused session", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ["thread", "/api/projects/project/sessions/thread?ifEmpty=1"],
    [null, "/api/projects/project/empty-session"],
  ])("requests guarded cleanup in either workspace mode (%s)", (session, url) => {
    removeWhenLeft("project", session)
    expect(fetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(fetch).toHaveBeenCalledWith(url, {
      method: "DELETE", credentials: "include", keepalive: true,
    })
  })

  it.each(["thread", null])("cancels cleanup when the same session reopens (%s)", (session) => {
    removeWhenLeft("project", session)
    keepSession(session ?? "project")
    vi.advanceTimersByTime(2000)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("keeps another session's pending cleanup when a different session opens", () => {
    removeWhenLeft("project", "old")
    keepSession("new")
    vi.advanceTimersByTime(1500)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("coalesces repeated departures", () => {
    removeWhenLeft("project", null)
    removeWhenLeft("project", null)
    vi.advanceTimersByTime(1500)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
