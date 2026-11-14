import { describe, expect, it } from "vitest"
import { RESOURCE_DRAG_TYPE } from "@ucch/protocol/plain"
import { parseResourceDrag, readResourceDrag } from "./resources-api"

const payload = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  storeId: "workspace",
  key: "images/logo.png",
  name: "logo.png",
  kind: "file",
}

const transfer = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" })

describe("resource drags", () => {
  it("reads back what a row put on the drag", () => {
    expect(readResourceDrag(transfer({ [RESOURCE_DRAG_TYPE]: JSON.stringify(payload) }))).toEqual(payload)
  })

  it("ignores drags that are not ours or are malformed", () => {
    expect(readResourceDrag(transfer({}))).toBeNull()
    expect(readResourceDrag(transfer({ [RESOURCE_DRAG_TYPE]: "{not json" }))).toBeNull()
    expect(parseResourceDrag({ ...payload, kind: "symlink" })).toBeNull()
    expect(parseResourceDrag({ ...payload, key: "" })).toBeNull()
    expect(parseResourceDrag(null)).toBeNull()
  })
})
