import { describe, expect, it } from "vitest"
import { defaultUrlTransform } from "react-markdown"
import { looksLikeFilePath, parseFileHref } from "./file-href"

describe("parseFileHref", () => {
  it("reads the citation form every harness is taught", () => {
    expect(parseFileHref("apps/server/src/agent.ts:42")).toEqual({ path: "apps/server/src/agent.ts", line: 42 })
    expect(parseFileHref("README.md:3")).toEqual({ path: "README.md", line: 3 })
    expect(parseFileHref("./src/a.ts:7:12")).toEqual({ path: "src/a.ts", line: 7 })
    expect(parseFileHref("src/a.ts")).toEqual({ path: "src/a.ts", line: null })
    expect(parseFileHref("src/a.ts:0")).toEqual({ path: "src/a.ts", line: null })
  })

  it("leaves URLs, absolute paths, paths out of the project and anchors alone", () => {
    for (const href of [
      "https://example.com/a.ts",
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "/etc/passwd.txt",
      "../secret.env",
      "src/../a.ts",
      "src//a.ts",
      "a.ts#L3",
      "a.ts?x=1",
      "docs",
      "",
      undefined,
    ]) {
      expect(parseFileHref(href), String(href)).toBeNull()
    }
  })

  it("keeps a root-level citation that react-markdown's default filter would drop", () => {
    expect(defaultUrlTransform("README.md:3")).toBe("")
    expect(parseFileHref("README.md:3")).not.toBeNull()
  })
})

describe("looksLikeFilePath", () => {
  it("tells a file from code", () => {
    expect(looksLikeFilePath("src/brand.ts")).toBe(true)
    expect(looksLikeFilePath(".env.example")).toBe(true)
    expect(looksLikeFilePath("console.log")).toBe(false)
    expect(looksLikeFilePath("1.5")).toBe(false)
  })
})
