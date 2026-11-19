"use client"

import * as React from "react"
import {
  FingerprintIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react"
import type { SshHostSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { SshHostDialog } from "@/components/terminal/ssh-host-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import { qk } from "@/lib/query-keys"
import { useSshHosts, useWorkspacePermissions } from "@/lib/queries/ssh"
import { sectionById, sectionHref } from "@/lib/sections"
import { deleteSshHost, retrustSshHost } from "@/lib/ssh-api"
import { requestOpenHost } from "@/lib/terminal-requests"
import { useInvalidate } from "@/lib/use-invalidate"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The Terminal section's sidebar column: the workspace's saved servers.
 *
 * A row opens a new terminal tab on that server (and goes to the Terminal
 * page on the way). Managers add, edit, re-trust and remove servers from
 * here; everyone else who can write connects.
 */
export function SshHostsPanel({
  workspaceId,
  compact = false,
  onNavigate,
}: {
  workspaceId: string
  compact?: boolean
  onNavigate?: () => void
}) {
  const ws = useWorkspaceHash()
  const invalidate = useInvalidate()
  const permissions = useWorkspacePermissions()
  const canManage = permissions.includes("workspace.manage")
  const canConnect = permissions.includes("project.write")
  const { data: hosts, isPending, error } = useSshHosts(workspaceId)
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<SshHostSummary | null>(null)
  const [removing, setRemoving] = React.useState<SshHostSummary | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const href = sectionHref(sectionById("terminal"), ws)

  async function retrust(host: SshHostSummary) {
    setNotice(null)
    try {
      const saved = await retrustSshHost(host.id)
      invalidate(qk.sshHosts.all)
      setNotice(`${host.name} now trusts ${saved.hostKeySha256 ?? "its new key"}.`)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <SidebarGroup className="px-0">
      {!compact && (
        <>
          <SidebarGroupLabel className="px-4">Servers</SidebarGroupLabel>
          {canManage && (
            <SidebarGroupAction aria-label="Add a server" onClick={() => setAdding(true)}>
              <PlusIcon />
            </SidebarGroupAction>
          )}
        </>
      )}
      <SidebarGroupContent>
        {isPending ? (
          <SidebarMenu className="gap-[5px] px-2">
            {Array.from({ length: 3 }, (_, i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        ) : error ? (
          <p role="alert" className="text-destructive px-4 py-2 text-xs">
            {error.message}
          </p>
        ) : !hosts || hosts.length === 0 ? (
          <div className="flex flex-col gap-2 px-4 py-2">
            <p className="text-muted-foreground text-sm">
              {canManage
                ? "No servers yet. Add a VPS or any machine you reach over SSH, and open shells on it here."
                : "No servers yet. Someone who manages this workspace can add one."}
            </p>
            {canManage && !compact && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="text-ucch-active hover:bg-muted/60 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm"
              >
                <PlusIcon className="size-3.5" />
                Add a server
              </button>
            )}
          </div>
        ) : (
          <SidebarMenu className="gap-[5px] px-2">
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                href={href}
                compact={compact}
                canManage={canManage}
                canConnect={canConnect}
                onNavigate={onNavigate}
                onEdit={() => setEditing(host)}
                onRetrust={() => void retrust(host)}
                onRemove={() => setRemoving(host)}
              />
            ))}
          </SidebarMenu>
        )}
        {notice && <p className="text-muted-foreground px-4 py-2 text-xs break-words">{notice}</p>}
      </SidebarGroupContent>

      {!compact && canManage && (
        <>
          <SshHostDialog
            workspaceId={workspaceId}
            open={adding}
            onOpenChange={setAdding}
            onSaved={(host) => {
              if (canConnect) requestOpenHost(host.id)
            }}
          />
          <SshHostDialog
            workspaceId={workspaceId}
            host={editing ?? undefined}
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
          />
          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(open) => !open && setRemoving(null)}
            title={`Remove ${removing?.name ?? "server"}?`}
            description="Only the saved login is removed, and the terminals open on it close. Nothing on the server changes."
            confirmLabel="Remove"
            onConfirm={async () => {
              if (!removing) return
              await deleteSshHost(removing.id)
              invalidate(qk.sshHosts.all)
            }}
          />
        </>
      )}
    </SidebarGroup>
  )
}

function HostRow({
  host,
  href,
  compact,
  canManage,
  canConnect,
  onNavigate,
  onEdit,
  onRetrust,
  onRemove,
}: {
  host: SshHostSummary
  href: string
  compact: boolean
  canManage: boolean
  canConnect: boolean
  onNavigate?: () => void
  onEdit: () => void
  onRetrust: () => void
  onRemove: () => void
}) {
  const { isMobile } = useSidebar()
  const address = `${host.username}@${host.host}${host.port === 22 ? "" : `:${host.port}`}`

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={address}
        className="h-auto py-1.5"
        onClick={() => {
          if (canConnect) requestOpenHost(host.id)
          onNavigate?.()
        }}
        render={<TransitionLink href={href} />}
      >
        <ServerIcon />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{host.name}</span>
          <span className="text-muted-foreground truncate text-[11px]">{address}</span>
        </span>
      </SidebarMenuButton>
      {!compact && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuAction showOnHover className="top-2.5 aria-expanded:bg-muted" />}>
            <MoreHorizontalIcon />
            <span className="sr-only">More for {host.name}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" side={isMobile ? "bottom" : "right"} align={isMobile ? "end" : "start"}>
            <div className="text-muted-foreground px-2 py-1.5 text-xs break-all">{address}</div>
            {host.hostKeySha256 && (
              <div className="text-muted-foreground flex items-start gap-1.5 px-2 pb-1.5 font-mono text-[10px] break-all">
                <FingerprintIcon className="mt-px size-3 shrink-0" />
                {host.hostKeySha256}
              </div>
            )}
            {canConnect && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  render={<TransitionLink href={href} />}
                  onClick={() => {
                    requestOpenHost(host.id)
                    onNavigate?.()
                  }}
                >
                  <SquareTerminalIcon className="text-muted-foreground" />
                  <span>New terminal</span>
                </DropdownMenuItem>
              </>
            )}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onEdit}>
                  <SettingsIcon className="text-muted-foreground" />
                  <span>Edit server</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRetrust}>
                  <FingerprintIcon className="text-muted-foreground" />
                  <span>Re-trust host key</span>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Trash2Icon />
                  <span>Remove server</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarMenuItem>
  )
}
