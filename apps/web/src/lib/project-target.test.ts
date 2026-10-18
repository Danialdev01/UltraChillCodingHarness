import { describe, expect, it } from "vitest"

import { projectApiUrl, targetOf } from "./project-target"

describe("projectApiUrl", () => {
  it("is the project's checkout for a bare hash", () => {
    expect(projectApiUrl("abc", "files")).toBe("/api/projects/abc/files")
    expect(projectApiUrl("abc", "file", { path: "a b.ts" })).toBe("/api/projects/abc/file?path=a+b.ts")
  })

  it("names the session's worktree when there is one", () => {
    expect(projectApiUrl({ hash: "abc", session: "s1" }, "git/status")).toBe("/api/projects/abc/git/status?session=s1")
    expect(projectApiUrl({ hash: "abc", session: "s1" }, "file", { path: "x" })).toBe(
      "/api/projects/abc/file?path=x&session=s1",
    )
    expect(projectApiUrl({ hash: "abc", session: null }, "files")).toBe("/api/projects/abc/files")
  })

  it("joins a query the path already carries", () => {
    expect(projectApiUrl({ hash: "abc", session: "s1" }, "git/diff?path=a%2Fb&scope=staged")).toBe(
      "/api/projects/abc/git/diff?path=a%2Fb&scope=staged&session=s1",
    )
  })
})

describe("targetOf", () => {
  it("carries the session only when the project view has one", () => {
    expect(targetOf({ hash: "abc" })).toBe("abc")
    expect(targetOf({ hash: "abc", sessionHash: "s1" })).toEqual({ hash: "abc", session: "s1" })
  })
})
