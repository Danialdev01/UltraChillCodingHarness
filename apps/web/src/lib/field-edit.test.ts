import { describe, expect, it } from "vitest"

import { fieldChanges, removeRow, upsertRow } from "./field-edit"

describe("fieldChanges", () => {
  const start = { title: "Ship", startsOn: "2026-10-01", endsOn: "2026-10-05", references: [{ kind: "url", url: "https://a" }] }

  it("keeps only what changed, with what it held before", () => {
    expect(fieldChanges(start, { title: "Ship it", startsOn: "2026-10-01" })).toEqual({
      patch: { title: "Ship it" },
      base: { title: "Ship" },
    })
  })

  it("compares lists by value, and skips fields left out", () => {
    expect(fieldChanges(start, { references: [{ kind: "url", url: "https://a" }], endsOn: undefined })).toEqual({
      patch: {},
      base: {},
    })
  })
})

describe("upsertRow / removeRow", () => {
  it("replaces only the named row", () => {
    const list = [
      { id: "a", updatedAt: "1" },
      { id: "b", updatedAt: "1" },
    ]
    expect(upsertRow({ id: "b", updatedAt: "2" })(list)).toEqual([list[0], { id: "b", updatedAt: "2" }])
    expect(removeRow("a")(list)).toEqual([list[1]])
    expect(removeRow("z")(list)).toBe(list)
  })
})
