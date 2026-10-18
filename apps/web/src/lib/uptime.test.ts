import { describe, expect, it } from "vitest"

import { uptime } from "./uptime"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("uptime", () => {
  it("says the coarsest unit", () => {
    expect(uptime(ago(30_000), NOW)).toBe("0m")
    expect(uptime(ago(5 * 60_000), NOW)).toBe("5m")
    expect(uptime(ago(3 * 3_600_000), NOW)).toBe("3h")
    expect(uptime(ago(2 * 86_400_000), NOW)).toBe("2d")
  })

  it("is empty before the clock is stamped or without a date", () => {
    expect(uptime(ago(60_000), null)).toBe("")
    expect(uptime(undefined, NOW)).toBe("")
  })

  it("never goes negative for a clock running behind", () => {
    expect(uptime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("0m")
  })
})
