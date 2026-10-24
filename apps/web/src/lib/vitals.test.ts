import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** A fresh copy of the module: whether a load is sampled is decided once. */
async function load(rate?: string) {
  vi.resetModules()
  if (rate !== undefined) vi.stubEnv("NEXT_PUBLIC_VITALS_SAMPLE_RATE", rate)
  return import("./vitals")
}

const beacons: Array<{ url: string; body: { vitals: Array<{ name: string; value: number; path: string }> } }> = []

beforeEach(() => {
  vi.useFakeTimers()
  beacons.length = 0
  vi.stubGlobal("window", {})
  vi.stubGlobal("location", { pathname: "/ws1/p/proj1", href: "http://localhost/ws1/p/proj1" })
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, body: Blob) => {
      // Read asynchronously; each test lets the timers settle before looking.
      void body.text().then((text) => beacons.push({ url, body: JSON.parse(text) }))
      return true
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("reportVital", () => {
  it("batches what it is given and sends it on the timer", async () => {
    const { reportVital } = await load()
    reportVital("nav-skeleton", 42.1234)
    reportVital("LCP", 900, "/login")
    expect(beacons).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(beacons).toHaveLength(1)
    expect(beacons[0]!.url).toBe("/api/metrics/vitals")
    expect(beacons[0]!.body.vitals).toEqual([
      { name: "nav-skeleton", value: 42.123, path: "/ws1/p/proj1" },
      { name: "LCP", value: 900, path: "/login" },
    ])
  })

  it("sends at once when the batch is full, never more than the server takes", async () => {
    const { MAX_BATCH, reportVital } = await load()
    for (let i = 0; i < MAX_BATCH; i++) reportVital("frame-to-paint", i)
    await vi.advanceTimersByTimeAsync(0)
    expect(beacons).toHaveLength(1)
    expect(beacons[0]!.body.vitals).toHaveLength(MAX_BATCH)
  })

  it("ignores values that are not timings", async () => {
    const { flushVitals, reportVital } = await load()
    reportVital("INP", Number.NaN)
    reportVital("INP", -3)
    flushVitals()
    await vi.advanceTimersByTimeAsync(0)
    expect(beacons).toHaveLength(0)
  })

  it("reports nothing from a load outside the sample", async () => {
    const { flushVitals, reportVital, vitalsEnabled } = await load("0")
    expect(vitalsEnabled()).toBe(false)
    reportVital("LCP", 900)
    flushVitals()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(beacons).toHaveLength(0)
  })
})
