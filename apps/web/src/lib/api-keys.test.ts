import { afterEach, describe, expect, it, vi } from "vitest"

import { MASK, maskKey, relativeWhen, revealApiKey, writeClipboardLater } from "./api-keys"

const NOW = Date.parse("2026-11-07T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("maskKey", () => {
  it("draws prefix, dots and last four from metadata alone", () => {
    expect(maskKey({ prefix: "sk-or-v1-", last4: "bf58" })).toBe(`sk-or-v1-${MASK}bf58`)
    expect(maskKey({ prefix: "", last4: "abcd" })).toBe(`${MASK}abcd`)
  })
})

describe("relativeWhen", () => {
  it("reads like a sentence", () => {
    expect(relativeWhen(null, NOW)).toBe("Never")
    expect(relativeWhen(ago(10_000), NOW)).toBe("Just now")
    expect(relativeWhen(ago(2 * 60_000), NOW)).toBe("2 minutes ago")
    expect(relativeWhen(ago(3 * 3_600_000), NOW)).toBe("3 hours ago")
    expect(relativeWhen(ago(26 * 3_600_000), NOW)).toBe("Yesterday")
    expect(relativeWhen(ago(15 * 86_400_000), NOW)).toBe("2 weeks ago")
  })
})

describe("revealApiKey", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("posts, uncached, and turns REAUTH_REQUIRED into a step-up request", async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init)
      return new Response(JSON.stringify({ code: "REAUTH_REQUIRED", error: "Confirm" }), { status: 403 })
    })
    expect(await revealApiKey("openrouter", "copy")).toEqual({ kind: "reauth" })
    expect(calls[0]).toMatchObject({ method: "POST", cache: "no-store", body: JSON.stringify({ purpose: "copy" }) })
  })
})

describe("writeClipboardLater", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("writes the key when it arrives, and nothing when it does not", async () => {
    const written: string[] = []
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text)
        },
      },
    })
    expect(await writeClipboardLater(Promise.resolve("sk-or-v1-key"))).toBe(true)
    expect(await writeClipboardLater(Promise.resolve(null))).toBe(false)
    expect(written).toEqual(["sk-or-v1-key"])
  })

  it("reports a refused write", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } })
    expect(await writeClipboardLater(Promise.resolve("k"))).toBe(false)
  })
})
