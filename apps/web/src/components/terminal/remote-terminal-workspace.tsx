"use client"

import * as React from "react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import {
  Columns2Icon,
  FolderTreeIcon,
  PlusIcon,
  RotateCwIcon,
  Rows2Icon,
  ServerIcon,
  SparklesIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react"
import type { SshHostSummary } from "@ucch/protocol"

import { RemoteChatPanel } from "@/components/terminal/remote-chat-panel"
import { RemoteFilesPanel } from "@/components/terminal/remote-files-panel"
import { SshHostDialog } from "@/components/terminal/ssh-host-dialog"
import { TerminalWorkspaceSkeleton } from "@/components/page-skeletons"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { xtermTheme } from "@/components/xterm-pane"
import { useSshHosts, useWorkspacePermissions } from "@/lib/queries/ssh"
import { useRealtime } from "@/lib/realtime"
import {
  activePane,
  allPanes,
  closePane,
  closeTab,
  EMPTY_LAYOUT,
  focusPane,
  MAX_PANES_PER_TAB,
  openTab,
  panesOf,
  parseLayout,
  selectTab,
  splitPane,
  withoutHosts,
  type LayoutNode,
  type PaneNode,
  type SplitDirection,
  type TerminalLayout,
  type TerminalTab,
} from "@/lib/terminal-layout"
import { TerminalSessions, type SessionStatus } from "@/lib/terminal-sessions"
import { onOpenHostRequest } from "@/lib/terminal-requests"
import { cn } from "@/lib/utils"
import { useActiveWorkspace } from "@/lib/workspace-context"

const STORAGE_PREFIX = "ucch.terminal.layout."
const PANELS_KEY = "ucch.terminal.panels"

function loadLayout(workspaceId: string): TerminalLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + workspaceId)
    return raw ? parseLayout(JSON.parse(raw)) : EMPTY_LAYOUT
  } catch {
    return EMPTY_LAYOUT
  }
}

function saveLayout(workspaceId: string, layout: TerminalLayout): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + workspaceId, JSON.stringify(layout))
  } catch {
    // Private mode or a full store: the layout just is not remembered.
  }
}

function loadPanels(): { files: boolean; chat: boolean } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PANELS_KEY) ?? "{}") as { files?: unknown; chat?: unknown }
    return { files: raw.files === true, chat: raw.chat === true }
  } catch {
    return { files: false, chat: false }
  }
}

/** A selection someone asked the agent about, with the pane it came from. */
export interface AskRequest {
  text: string
  hostId: string
  token: number
}

/**
 * The Terminal section's page: shells on the workspace's SSH hosts, in tabs
 * that each split into up to four panes side by side or stacked, with the
 * focused pane's files on the left and an agent that works on its server
 * on the right.
 *
 * The layout is remembered per workspace in this browser; the shells are
 * not -- a reload opens fresh ones in the same places.
 */
export function RemoteTerminalWorkspace() {
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const { data: hosts, isPending } = useSshHosts(workspaceId)
  const permissions = useWorkspacePermissions()
  const canConnect = permissions.includes("project.write")
  const canManage = permissions.includes("workspace.manage")

  const { client } = useRealtime()
  const { tokens, resolvedMode } = useTheme()
  const theme = React.useMemo(() => xtermTheme(tokens, resolvedMode), [tokens, resolvedMode])

  const [layout, setLayout] = React.useState<TerminalLayout>(EMPTY_LAYOUT)
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null)
  const [panels, setPanels] = React.useState({ files: false, chat: false })
  const [statuses, setStatuses] = React.useState<Record<string, { status: SessionStatus; error: string | null }>>({})
  const [selections, setSelections] = React.useState<Record<string, string>>({})
  const [ask, setAsk] = React.useState<AskRequest | null>(null)
  const [adding, setAdding] = React.useState(false)

  const sessionsRef = React.useRef<TerminalSessions | null>(null)
  const [sessions, setSessions] = React.useState<TerminalSessions | null>(null)
  const layoutRef = React.useRef(layout)
  layoutRef.current = layout

  // The layout this workspace had in this browser, once per workspace.
  React.useEffect(() => {
    if (!workspaceId) return
    setLayout(loadLayout(workspaceId))
    setLoadedFor(workspaceId)
    setPanels(loadPanels())
  }, [workspaceId])

  React.useEffect(() => {
    if (workspaceId && loadedFor === workspaceId) saveLayout(workspaceId, layout)
  }, [workspaceId, loadedFor, layout])

  React.useEffect(() => {
    try {
      window.localStorage.setItem(PANELS_KEY, JSON.stringify(panels))
    } catch {
      /* not remembered */
    }
  }, [panels])

  // One manager for the page's shells, on the tab's socket.
  React.useEffect(() => {
    if (!client) return
    const manager = new TerminalSessions(client, theme, {
      status: (paneId, status, error) => setStatuses((current) => ({ ...current, [paneId]: { status, error } })),
      selection: (paneId, text) =>
        setSelections((current) => (current[paneId] === text ? current : { ...current, [paneId]: text })),
      focus: (paneId) => {
        const tab = layoutRef.current.tabs.find((t) => panesOf(t.root).some((p) => p.id === paneId))
        if (tab) setLayout((current) => focusPane(current, tab.id, paneId))
      },
    })
    sessionsRef.current = manager
    setSessions(manager)
    // A reload or a closed tab ends this page's shells now, rather than when
    // the server notices nobody watches them; the panes reopen fresh ones.
    const leave = () => manager.destroy()
    window.addEventListener("pagehide", leave)
    return () => {
      window.removeEventListener("pagehide", leave)
      manager.destroy()
      sessionsRef.current = null
      setSessions(null)
    }
    // The theme is applied below; a new one must not end every shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  React.useEffect(() => {
    sessions?.setTheme(theme)
  }, [sessions, theme])

  // A pane closed ends its shell; hosts that went close their panes.
  const known = React.useMemo(() => new Set((hosts ?? []).map((h) => h.id)), [hosts])
  React.useEffect(() => {
    if (!hosts) return
    setLayout((current) => withoutHosts(current, known))
  }, [hosts, known])
  React.useEffect(() => {
    sessions?.disposeExcept(new Set(allPanes(layout).map((p) => p.id)))
  }, [sessions, layout])

  // "Open in a new tab" from the sidebar, possibly sent before this mounted.
  React.useEffect(() => {
    if (loadedFor !== workspaceId || !canConnect) return
    return onOpenHostRequest((hostId) => setLayout((current) => openTab(current, hostId)))
  }, [loadedFor, workspaceId, canConnect])

  const hostById = React.useMemo(() => new Map((hosts ?? []).map((h) => [h.id, h])), [hosts])
  const tab = layout.tabs.find((t) => t.id === layout.activeTabId) ?? null
  const focused = activePane(layout)
  const focusedHost = focused ? (hostById.get(focused.hostId) ?? null) : null

  const split = (tabId: string, paneId: string, direction: SplitDirection, hostId: string) =>
    setLayout((current) => splitPane(current, tabId, paneId, direction, hostId))

  if (!workspaceId || isPending || loadedFor !== workspaceId) return <TerminalWorkspaceSkeleton />

  if (!canConnect) {
    return (
      <Centered icon={SquareTerminalIcon} title="Terminals need write access">
        Your role in this workspace can see its servers but not open shells on them.
      </Centered>
    )
  }

  if (!hosts || hosts.length === 0) {
    return (
      <>
        <Centered icon={ServerIcon} title="No servers yet">
          {canManage
            ? "Add a VPS or any machine you reach over SSH. Its shells open here in tabs and splits, beside its files and an agent that works on it."
            : "Someone who manages this workspace can add a server; its shells open here."}
          {canManage && (
            <Button className="mt-4" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add a server
            </Button>
          )}
        </Centered>
        {canManage && (
          <SshHostDialog
            workspaceId={workspaceId}
            open={adding}
            onOpenChange={setAdding}
            onSaved={(host) => setLayout((current) => openTab(current, host.id))}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TabStrip
        layout={layout}
        hosts={hosts}
        hostById={hostById}
        panels={panels}
        onSelect={(id) => setLayout((current) => selectTab(current, id))}
        onClose={(id) => setLayout((current) => closeTab(current, id))}
        onOpen={(hostId) => setLayout((current) => openTab(current, hostId))}
        onTogglePanel={(which) => setPanels((current) => ({ ...current, [which]: !current[which] }))}
      />

      <PanelGroup direction="horizontal" autoSaveId="ucch-terminal-columns" className="min-h-0 flex-1">
        {panels.files && (
          <>
            <Panel id="files" order={1} defaultSize={22} minSize={14} maxSize={45}>
              <RemoteFilesPanel host={focusedHost} onClose={() => setPanels((p) => ({ ...p, files: false }))} />
            </Panel>
            <ResizeHandle direction="horizontal" />
          </>
        )}
        <Panel id="terminals" order={2} minSize={30}>
          <div className="relative flex h-full min-h-0 flex-col">
            {layout.tabs.length === 0 && (
              <HostPicker hosts={hosts} onPick={(hostId) => setLayout((current) => openTab(current, hostId))} />
            )}
            {sessions &&
              layout.tabs.map((t) => (
                <div key={t.id} className={cn("min-h-0 flex-1", t.id !== layout.activeTabId && "hidden")}>
                  <LayoutView
                    node={t.root}
                    tab={t}
                    visible={t.id === layout.activeTabId}
                    sessions={sessions}
                    hosts={hosts}
                    hostById={hostById}
                    statuses={statuses}
                    selections={selections}
                    onFocus={(paneId) => setLayout((current) => focusPane(current, t.id, paneId))}
                    onSplit={(paneId, direction, hostId) => split(t.id, paneId, direction, hostId)}
                    onClose={(paneId) => setLayout((current) => closePane(current, t.id, paneId))}
                    onAsk={(pane, text) => {
                      setPanels((p) => ({ ...p, chat: true }))
                      setAsk({ text, hostId: pane.hostId, token: Date.now() })
                      sessions.clearSelection(pane.id)
                    }}
                  />
                </div>
              ))}
          </div>
        </Panel>
        {panels.chat && (
          <>
            <ResizeHandle direction="horizontal" />
            <Panel id="chat" order={3} defaultSize={28} minSize={20} maxSize={50}>
              <RemoteChatPanel
                hosts={hosts}
                focusedHostId={focusedHost?.id ?? null}
                ask={ask}
                onInsert={(command) => {
                  const pane = focused ?? (tab ? panesOf(tab.root)[0] : undefined)
                  if (pane) sessions?.paste(pane.id, command)
                }}
                onClose={() => setPanels((p) => ({ ...p, chat: false }))}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  )
}

function ResizeHandle({ direction }: { direction: SplitDirection }) {
  return (
    <PanelResizeHandle
      className={cn(
        "bg-border hover:bg-ucch-active/60 data-[resize-handle-state=drag]:bg-ucch-active relative shrink-0 transition-colors",
        direction === "horizontal" ? "w-px after:absolute after:inset-y-0 after:-left-1 after:w-2" : "h-px after:absolute after:inset-x-0 after:-top-1 after:h-2",
      )}
    />
  )
}

function TabStrip({
  layout,
  hosts,
  hostById,
  panels,
  onSelect,
  onClose,
  onOpen,
  onTogglePanel,
}: {
  layout: TerminalLayout
  hosts: SshHostSummary[]
  hostById: Map<string, SshHostSummary>
  panels: { files: boolean; chat: boolean }
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onOpen: (hostId: string) => void
  onTogglePanel: (which: "files" | "chat") => void
}) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b">
      <div role="tablist" aria-label="Terminals" className="no-scrollbar flex h-full min-w-0 items-center overflow-x-auto">
        {layout.tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            active={t.id === layout.activeTabId}
            hostById={hostById}
            onSelect={() => onSelect(t.id)}
            onClose={() => onClose(t.id)}
          />
        ))}
        <NewTabMenu hosts={hosts} onOpen={onOpen} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={panels.files}
          className={cn(panels.files && "bg-muted text-foreground")}
          onClick={() => onTogglePanel("files")}
        >
          <FolderTreeIcon />
          <span className="hidden sm:inline">Files</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={panels.chat}
          className={cn(panels.chat && "bg-muted text-foreground")}
          onClick={() => onTogglePanel("chat")}
        >
          <SparklesIcon />
          <span className="hidden sm:inline">Agent</span>
        </Button>
      </div>
    </div>
  )
}

function TabButton({
  tab,
  active,
  hostById,
  onSelect,
  onClose,
}: {
  tab: TerminalTab
  active: boolean
  hostById: Map<string, SshHostSummary>
  onSelect: () => void
  onClose: () => void
}) {
  const panes = panesOf(tab.root)
  const names = [...new Set(panes.map((p) => hostById.get(p.hostId)?.name ?? "Server"))]
  const title = names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
  return (
    <div
      className={cn(
        "group/tab flex h-full shrink-0 items-center gap-2 border-r pr-1 pl-3 text-sm",
        active ? "border-b-ucch-active bg-background text-ucch-active border-b-2" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        onMouseDown={(event) => event.preventDefault()}
        className="flex max-w-48 items-center gap-1.5 outline-hidden"
      >
        <SquareTerminalIcon className="size-3.5 shrink-0" />
        <span className="truncate">{title}</span>
        {panes.length > 1 && <span className="text-muted-foreground text-[11px]">{panes.length}</span>}
      </button>
      <button
        type="button"
        onClick={onClose}
        className={cn("hover:bg-muted rounded-sm p-0.5 opacity-0 group-hover/tab:opacity-100", active && "opacity-100")}
      >
        <XIcon className="size-3.5" />
        <span className="sr-only">Close {title}</span>
      </button>
    </div>
  )
}

function NewTabMenu({ hosts, onOpen }: { hosts: SshHostSummary[]; onOpen: (hostId: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="New terminal"
            className="text-muted-foreground hover:bg-muted/50 hover:text-foreground ml-1 flex size-7 shrink-0 items-center justify-center rounded-md"
          />
        }
      >
        <PlusIcon className="size-4" />
        <span className="sr-only">New terminal</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" align="start">
        <DropdownMenuLabel>Open a terminal on</DropdownMenuLabel>
        {hosts.map((host) => (
          <DropdownMenuItem key={host.id} onClick={() => onOpen(host.id)}>
            <ServerIcon className="text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{host.name}</span>
              <span className="text-muted-foreground truncate text-[11px]">
                {host.username}@{host.host}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HostPicker({ hosts, onPick }: { hosts: SshHostSummary[]; onPick: (hostId: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-8">
      <div className="flex flex-col items-center gap-1 text-center">
        <SquareTerminalIcon className="text-muted-foreground size-6" />
        <h2 className="text-base font-semibold">Open a terminal</h2>
        <p className="text-muted-foreground max-w-sm text-sm">Pick a server. Split it beside another from the pane&apos;s header.</p>
      </div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {hosts.map((host) => (
          <button
            key={host.id}
            type="button"
            onClick={() => onPick(host.id)}
            className="hover:border-ucch-active/60 hover:bg-muted/40 flex items-center gap-3 rounded-lg border p-3 text-left transition-colors"
          >
            <ServerIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{host.name}</span>
              <span className="text-muted-foreground truncate text-xs">
                {host.username}@{host.host}
                {host.port === 22 ? "" : `:${host.port}`}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

interface PaneHandlers {
  tab: TerminalTab
  visible: boolean
  sessions: TerminalSessions
  hosts: SshHostSummary[]
  hostById: Map<string, SshHostSummary>
  statuses: Record<string, { status: SessionStatus; error: string | null }>
  selections: Record<string, string>
  onFocus: (paneId: string) => void
  onSplit: (paneId: string, direction: SplitDirection, hostId: string) => void
  onClose: (paneId: string) => void
  onAsk: (pane: PaneNode, text: string) => void
}

/** One node of a tab's tree: a split of panels, or a pane. */
function LayoutView({ node, ...rest }: PaneHandlers & { node: LayoutNode }) {
  if (node.kind === "pane") return <PaneView pane={node} {...rest} />
  return (
    <PanelGroup direction={node.direction} id={node.id} className="h-full">
      {node.children.map((child, index) => (
        <React.Fragment key={child.id}>
          {index > 0 && <ResizeHandle direction={node.direction} />}
          <Panel id={child.id} order={index} minSize={12}>
            <LayoutView node={child} {...rest} />
          </Panel>
        </React.Fragment>
      ))}
    </PanelGroup>
  )
}

function PaneView({
  pane,
  tab,
  visible,
  sessions,
  hosts,
  hostById,
  statuses,
  selections,
  onFocus,
  onSplit,
  onClose,
  onAsk,
}: PaneHandlers & { pane: PaneNode }) {
  const slot = React.useRef<HTMLDivElement>(null)
  const host = hostById.get(pane.hostId)
  const status = statuses[pane.id]?.status ?? "connecting"
  const selection = selections[pane.id] ?? ""
  const active = tab.activePaneId === pane.id
  const multiple = panesOf(tab.root).length > 1
  const full = panesOf(tab.root).length >= MAX_PANES_PER_TAB

  // Adopt the pane's screen; a split moving this pane elsewhere adopts it there.
  React.useLayoutEffect(() => {
    const element = slot.current
    if (!element) return
    sessions.ensure(pane.id, pane.hostId)
    sessions.attach(pane.id, element)
    return () => sessions.detach(pane.id, element)
  }, [sessions, pane.id, pane.hostId])

  React.useEffect(() => {
    const element = slot.current
    if (!element || !visible) return
    sessions.fit(pane.id)
    if (active) sessions.focus(pane.id)
    const observer = new ResizeObserver(() => sessions.fit(pane.id))
    observer.observe(element)
    return () => observer.disconnect()
    // Focus follows becoming visible or active, not every render.
  }, [sessions, pane.id, visible, active])

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", multiple && active && "ring-ucch-active/40 ring-1 ring-inset")}
      onMouseDown={() => onFocus(pane.id)}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <StatusDot status={status} />
        <span className={cn("truncate font-medium", !active && multiple && "text-muted-foreground")}>
          {host?.name ?? "Server"}
        </span>
        <span className="text-muted-foreground hidden truncate md:inline">
          {host ? `${host.username}@${host.host}` : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center">
          {(status === "exited" || status === "failed") && (
            <PaneButton label="Reconnect" onClick={() => sessions.restart(pane.id)}>
              <RotateCwIcon />
            </PaneButton>
          )}
          <SplitMenu
            label="Split right"
            disabled={full}
            hosts={hosts}
            current={pane.hostId}
            onPick={(hostId) => onSplit(pane.id, "horizontal", hostId)}
          >
            <Columns2Icon />
          </SplitMenu>
          <SplitMenu
            label="Split down"
            disabled={full}
            hosts={hosts}
            current={pane.hostId}
            onPick={(hostId) => onSplit(pane.id, "vertical", hostId)}
          >
            <Rows2Icon />
          </SplitMenu>
          <PaneButton label="Close pane" onClick={() => onClose(pane.id)}>
            <XIcon />
          </PaneButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={slot} className="absolute inset-0 overflow-hidden p-1.5" />
        {selection.trim() && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAsk(pane, selection)}
            className="bg-background text-foreground hover:border-ucch-active/60 absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs shadow-sm"
          >
            <SparklesIcon className="text-ucch-active size-3.5" />
            Ask the agent
          </button>
        )}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: SessionStatus }) {
  const label = { connecting: "Connecting", open: "Connected", exited: "Ended", failed: "Failed" }[status]
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "open" && "bg-success",
        status === "connecting" && "animate-pulse bg-warning",
        status === "exited" && "bg-muted-foreground/50",
        status === "failed" && "bg-destructive",
      )}
    />
  )
}

function PaneButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}

/** A split button: the same server by default, or another one from the list. */
function SplitMenu({
  label,
  disabled,
  hosts,
  current,
  onPick,
  children,
}: {
  label: string
  disabled: boolean
  hosts: SshHostSummary[]
  current: string
  onPick: (hostId: string) => void
  children: React.ReactNode
}) {
  if (hosts.length <= 1) {
    return (
      <button
        type="button"
        title={disabled ? `${label} (at most ${MAX_PANES_PER_TAB} panes)` : label}
        disabled={disabled}
        onClick={() => onPick(current)}
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md disabled:opacity-40 [&_svg]:size-3.5"
      >
        {children}
        <span className="sr-only">{label}</span>
      </button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            title={disabled ? `${label} (at most ${MAX_PANES_PER_TAB} panes)` : label}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md disabled:opacity-40 [&_svg]:size-3.5"
          />
        }
      >
        {children}
        <span className="sr-only">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {hosts
          .slice()
          .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0))
          .map((host, index) => (
            <React.Fragment key={host.id}>
              {index === 1 && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => onPick(host.id)}>
                <ServerIcon className="text-muted-foreground" />
                <span className="truncate">{host.name}</span>
                {host.id === current && <span className="text-muted-foreground ml-auto text-[11px]">same</span>}
              </DropdownMenuItem>
            </React.Fragment>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Centered({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <Icon className="text-muted-foreground mb-2 size-6" />
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-muted-foreground mt-1 flex max-w-md flex-col items-center text-sm">{children}</div>
    </div>
  )
}
