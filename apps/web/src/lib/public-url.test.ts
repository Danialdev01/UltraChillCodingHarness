import { describe, expect, it } from "vitest"
import { publicUrl } from "./public-url"

const internal = new URL("http://localhost:3100/login?next=%2F")

describe("publicUrl", () => {
  it("uses the forwarded host and scheme behind the proxies", () => {
    const headers = new Headers({ "x-forwarded-host": "ucch.example.com", "x-forwarded-proto": "https" })
    expect(publicUrl(internal, headers).toString()).toBe("https://ucch.example.com/login?next=%2F")
  })

  it("keeps a forwarded port, and takes the first of a proxy chain", () => {
    const headers = new Headers({ "x-forwarded-host": "localhost:3000, 127.0.0.1:3000", "x-forwarded-proto": "http, http" })
    expect(publicUrl(internal, headers).toString()).toBe("http://localhost:3000/login?next=%2F")
  })

  it("leaves the URL alone without a usable forwarded host", () => {
    for (const host of [null, "", "evil.example/path", "a b"]) {
      const headers = new Headers(host === null ? {} : { "x-forwarded-host": host })
      expect(publicUrl(internal, headers).toString()).toBe(internal.toString())
    }
  })
})
