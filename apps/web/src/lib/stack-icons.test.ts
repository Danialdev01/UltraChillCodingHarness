import { describe, expect, it } from "vitest"

import { stackIconName } from "./stack-icons.js"

describe("stackIconName", () => {
  it("names the framework's icon", () => {
    expect(stackIconName("nextjs")).toBe("next")
    expect(stackIconName("laravel")).toBe("laravel")
    expect(stackIconName("node")).toBe("nodejs")
  })

  it("has none for a stack it does not know, so the row shows a folder", () => {
    expect(stackIconName("unknown")).toBeNull()
    expect(stackIconName("cobol")).toBeNull()
    expect(stackIconName(null)).toBeNull()
    expect(stackIconName("")).toBeNull()
  })

  it("does not answer from the object's prototype", () => {
    expect(stackIconName("toString")).toBeNull()
  })
})
