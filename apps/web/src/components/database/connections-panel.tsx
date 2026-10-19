"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  ChevronRightIcon,
  CylinderIcon,
  DatabaseIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react"
import { DATABASE_ENGINE_LABELS, type DatabaseConnectionSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ConnectionSettingsDialog, CreateDatabaseDialog, NewDatabaseDialog } from "@/components/on-demand"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { deleteConnection, fetchDatabases, onDatabasesChanged } from "@/lib/database-api"
import {
  connectionHref,
  connectionIdFromPath,
  databaseHref,
  databasePathFromPath,
  sectionById,
  sectionHref,
} from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

/**
 * The Database section's sidebar column: every saved server, each unfolding
 * into the databases on it.
 *
 * Databases are asked for on first unfold rather than at render, because
 * each list is a round trip to a server of the user's, and the column is
 * on screen whenever the rail says Connections -- long before any of them
 * is wanted. Like the project list, one connection is unfolded at a time,
 * and the one the URL is on starts unfolded.
 *
 * The connection's own row is a link to its page -- the server and every
 * database on it -- and unfolds it on the way; the chevron unfolds without
 * leaving.
 */
export function ConnectionsPanel({
  connections,
  workspaceId,
  compact = false,
  onNavigate,
}: {
  connections: DatabaseConnectionSummary[]
  workspaceId: string
  compact?: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const current = databasePathFromPath(pathname)
  // On a connection's own page, or inside one of its databases.
  const currentConnectionId = current?.connectionId ?? connectionIdFromPath(pathname)
  const [unfolded, setUnfolded] = React.useState<string | null>(currentConnectionId)
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState<DatabaseConnectionSummary | null>(null)

  React.useEffect(() => {
    if (currentConnectionId) setUnfolded(currentConnectionId)
  }, [currentConnectionId])

  async function remove(connection: DatabaseConnectionSummary) {
    await deleteConnection(connection.id)
    if (currentConnectionId === connection.id) router.push(sectionHref(sectionById("database"), ws))
    router.refresh()
  }

  return (
    <SidebarGroup className="px-0">
      {!compact && (
        <>
          <SidebarGroupLabel className="px-4">Connections</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New database connection" onClick={() => setAdding(true)}>
            <PlusIcon />
          </SidebarGroupAction>
        </>
      )}
      <SidebarGroupContent>
        {connections.length === 0 ? (
          <p className="text-muted-foreground px-4 py-2 text-sm">
            No connections yet. Add a MySQL or PostgreSQL server and its databases appear here.
          </p>
        ) : (
          <SidebarMenu className="gap-[5px] px-2">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                open={!compact && unfolded === connection.id}
                onOpenChange={(next) => setUnfolded(next ? connection.id : null)}
                active={current?.connectionId === connection.id ? current.db : null}
                onPage={currentConnectionId === connection.id && !current}
                compact={compact}
                onNavigate={onNavigate}
                onRemove={() => setRemoving(connection)}
              />
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>

      {!compact && (
        <>
          <NewDatabaseDialog workspaceId={workspaceId} open={adding} onOpenChange={setAdding} />
          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(open) => !open && setRemoving(null)}
            title={`Remove ${removing?.name ?? "connection"}?`}
            description="Only the saved credentials are removed; nothing on the server changes."
            confirmLabel="Remove"
            onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
          />
        </>
      )}
    </SidebarGroup>
  )
}

type Listing =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; databases: string[] }
  | { state: "failed"; error: string }

function ConnectionRow({
  connection,
  open,
  onOpenChange,
  active,
  onPage,
  compact,
  onNavigate,
  onRemove,
}: {
  connection: DatabaseConnectionSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The database of this connection the page is on, if any. */
  active: string | null
  /** Whether the page is the connection's own. */
  onPage: boolean
  compact: boolean
  onNavigate?: () => void
  onRemove: () => void
}) {
  const { isMobile } = useSidebar()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [listing, setListing] = React.useState<Listing>({ state: "idle" })
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState(false)

  const load = React.useCallback(async () => {
    setListing({ state: "loading" })
    try {
      setListing({ state: "loaded", databases: await fetchDatabases(connection.id) })
    } catch (error) {
      setListing({ state: "failed", error: error instanceof Error ? error.message : "Could not reach the server." })
    }
  }, [connection.id])

  React.useEffect(() => {
    if (open && listing.state === "idle") void load()
  }, [open, listing.state, load])

  // A database made or dropped from a page: re-read the list if it has
  // been read at all; an unread one will be read fresh on first unfold.
  React.useEffect(
    () =>
      onDatabasesChanged((id) => {
        if (id === connection.id && listing.state === "loaded") void load()
      }),
    [connection.id, listing.state, load],
  )

  const subtitle = `${DATABASE_ENGINE_LABELS[connection.engine]} · ${connection.host}`

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<SidebarMenuItem />}>
      <SidebarMenuButton
        isActive={onPage || active !== null}
        tooltip={subtitle}
        onClick={() => {
          onOpenChange(true)
          onNavigate?.()
        }}
        aria-expanded={open}
        render={<TransitionLink href={connectionHref(ws, connection.id)} />}
      >
        <DatabaseIcon />
        <span className="truncate">{connection.name}</span>
      </SidebarMenuButton>
      {!compact && (
        <>
          <CollapsibleTrigger render={<SidebarMenuAction className="aria-expanded:rotate-90" />}>
            <ChevronRightIcon />
            <span className="sr-only">Toggle {connection.name}&apos;s databases</span>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<SidebarMenuAction showOnHover className="right-6 aria-expanded:bg-muted" />}
            >
              <MoreHorizontalIcon />
              <span className="sr-only">More for {connection.name}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-52"
              side={isMobile ? "bottom" : "right"}
              align={isMobile ? "end" : "start"}
            >
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                {connection.username}@{connection.host}:{connection.port}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCreating(true)}>
                <PlusIcon className="text-muted-foreground" />
                <span>New database</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void load()}>
                <RefreshCwIcon className="text-muted-foreground" />
                <span>Refresh databases</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <SettingsIcon className="text-muted-foreground" />
                <span>Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2Icon />
                <span>Remove connection</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ConnectionSettingsDialog connection={connection} open={editing} onOpenChange={setEditing} />
          <CreateDatabaseDialog
            connectionId={connection.id}
            connectionName={connection.name}
            open={creating}
            onOpenChange={setCreating}
            onCreated={async (name) => {
              onOpenChange(true)
              await load()
              router.push(databaseHref(ws, connection.id, name))
            }}
          />
          <CollapsibleContent>
            <SidebarMenuSub>
              {listing.state === "loading" || listing.state === "idle" ? (
                Array.from({ length: 3 }, (_, i) => <SidebarMenuSkeleton key={i} />)
              ) : listing.state === "failed" ? (
                <li className="px-2 py-1">
                  <p role="alert" className="text-destructive text-xs">
                    {listing.error}
                  </p>
                  <button type="button" className="text-muted-foreground mt-1 text-xs underline" onClick={() => void load()}>
                    Retry
                  </button>
                </li>
              ) : listing.databases.length === 0 ? (
                <li className="text-muted-foreground px-2 py-1 text-xs">No databases visible to this user.</li>
              ) : (
                listing.databases.map((db) => (
                  <SidebarMenuSubItem key={db}>
                    <SidebarMenuSubButton
                      isActive={active === db}
                      onClick={onNavigate}
                      render={<TransitionLink href={databaseHref(ws, connection.id, db)} />}
                    >
                      <CylinderIcon />
                      <span className="truncate">{db}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        </>
      )}
    </Collapsible>
  )
}
