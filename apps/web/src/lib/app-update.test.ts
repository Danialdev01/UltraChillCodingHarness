import { afterEach, describe, expect, it, vi } from "vitest"

import { isOtherBuild, reportServerBuild, reportWaitingWorker, resetUpdate, subscribeUpdate, takeUpdate, updateAvailable } from "./app-update"

afterEach(() => {
  resetUpdate()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("isOtherBuild", () => {
  it("compares only when both sides name a build", () => {
    expect(isOtherBuild("b", "a")).toBe(true)
    expect(isOtherBuild("a", "a")).toBe(false)
    expect(isOtherBuild(undefined, "a")).toBe(false)
    expect(isOtherBuild("b", undefined)).toBe(false)
    expect(isOtherBuild("b", "")).toBe(false)
  })
})

describe("the update store", () => {
  it("offers an update once the server runs another build, and tells its listeners", () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_ID", "a")
    const heard = vi.fn()
    subscribeUpdate(heard)
    reportServerBuild("a")
    expect(updateAvailable()).toBe(false)
    reportServerBuild("b")
    reportServerBuild("b")
    expect(updateAvailable()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("offers nothing without a build id of its own", () => {
    reportServerBuild("b")
    expect(updateAvailable()).toBe(false)
  })

  it("lets a waiting worker take over before reloading", () => {
    const reload = vi.fn()
    let onControllerChange: (() => void) | undefined
    const container = {
      addEventListener: (_: string, listener: () => void) => void (onControllerChange = listener),
    }
    vi.stubGlobal("navigator", { serviceWorker: container })
    vi.stubGlobal("location", { reload })
    const worker = { postMessage: vi.fn() } as unknown as ServiceWorker
    reportWaitingWorker(worker)
    expect(updateAvailable()).toBe(true)

    takeUpdate()
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })
    expect(reload).not.toHaveBeenCalled()
    onControllerChange?.()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("just reloads when there is no worker", () => {
    const reload = vi.fn()
    vi.stubGlobal("location", { reload })
    takeUpdate()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
