import { describe, expect, it } from "vitest"
import { needsSession, safeNext } from "./auth-gate"

describe("needsSession", () => {
  it("guards the app's pages", () => {
    for (const path of ["/", "/abcdefghijkl", "/abcdefghijkl/p/xyzxyzxyzxyz/tasks", "/setting/account", "/invite/tok"]) {
      expect(needsSession(path)).toBe(true)
    }
  })

  it("leaves sign-in, health and installable-app files open", () => {
    for (const path of ["/login", "/healthz", "/offline", "/icon.svg", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"]) {
      expect(needsSession(path)).toBe(false)
    }
  })
})

describe("safeNext", () => {
  it("keeps the app's own paths", () => {
    expect(safeNext("/abcdefghijkl/p/xyz/tasks?x=1")).toBe("/abcdefghijkl/p/xyz/tasks?x=1")
  })

  it("refuses anything that would leave the app or loop", () => {
    for (const next of [null, "", "https://evil.example", "//evil.example", "/\\evil", "/login", "/login?next=/", "/api/me"]) {
      expect(safeNext(next)).toBeNull()
    }
  })
})
