import { describe, expect, it } from "vitest"

import type { Bootstrap, Workspace } from "./session"
import { workspaceSwitchTarget } from "./view-transitions"
import { resolveShell, type Shell } from "./workspace-context"

const A = "aaaaaaaaaaaa"
const B = "bbbbbbbbbbbb"
const workspaces = [A, B].map((hash) => ({ id: `id-${hash}`, hash, name: hash }) as Workspace)
const boot = (hash: string) =>
  ({ me: {}, workspaces, activeWorkspaceId: `id-${hash}`, projects: [{ hash }], connections: [] }) as unknown as Bootstrap
const last = { workspace: workspaces[0], workspaces, projects: [{}], connections: [], loading: false } as unknown as Shell

describe("workspaceSwitchTarget", () => {
  it("is only another workspace's dashboard", () => {
    expect(workspaceSwitchTarget(`/${B}`, `/${A}/todo`)).toBe(`/${B}`)
    expect(workspaceSwitchTarget(`/${B}/`, "/")).toBe(`/${B}`)
    expect(workspaceSwitchTarget(`/${A}`, `/${A}/todo`)).toBeNull()
    expect(workspaceSwitchTarget(`/${B}/todo`, `/${A}`)).toBeNull()
    expect(workspaceSwitchTarget("/setting/account", `/${A}`)).toBeNull()
  })
})

describe("resolveShell", () => {
  it("shows the new workspace at once, without the old one's lists", () => {
    const shell = resolveShell({ wanted: B, addressed: true, cached: undefined, server: boot(A), last })
    expect(shell).toMatchObject({ workspace: { hash: B }, projects: [], loading: true })
  })

  it("uses the workspace's own bootstrap once it is cached", () => {
    const shell = resolveShell({ wanted: B, addressed: true, cached: boot(B), server: boot(A), last })
    expect(shell).toMatchObject({ workspace: { hash: B }, projects: [{ hash: B }], loading: false })
  })

  it("keeps the shell for an address that is no workspace", () => {
    const wanted = "cccccccccccc"
    expect(resolveShell({ wanted, addressed: true, cached: undefined, server: boot(A), last })).toBe(last)
    expect(resolveShell({ wanted, addressed: true, cached: boot(A), server: boot(A), last })).toBe(last)
  })

  it("falls back to the server's pick when a remembered workspace is gone", () => {
    const shell = resolveShell({ wanted: A, addressed: false, cached: boot(B), server: boot(A), last })
    expect(shell.workspace?.hash).toBe(B)
  })
})
