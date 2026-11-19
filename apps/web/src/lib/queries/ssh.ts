"use client"

import { useQuery } from "@tanstack/react-query"
import type { WorkspacePermission } from "@ucch/protocol"

import { qk } from "@/lib/query-keys"
import { fetchSshHosts } from "@/lib/ssh-api"
import { useBootstrap } from "@/lib/queries/bootstrap"
import { useActiveWorkspace } from "@/lib/workspace-context"

/** The open workspace's saved SSH hosts, kept current by `ssh_hosts` events. */
export function useSshHosts(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: qk.sshHosts.list(workspaceId ?? ""),
    queryFn: () => fetchSshHosts(workspaceId!),
    enabled: Boolean(workspaceId),
    meta: { persist: true },
  })
}

/** What the caller may do in the open workspace, from the shell's bootstrap. */
export function useWorkspacePermissions(): readonly WorkspacePermission[] {
  const active = useActiveWorkspace()
  const { data } = useBootstrap(active?.hash ?? null)
  return data?.workspaces.find((w) => w.id === active?.id)?.permissions ?? []
}
