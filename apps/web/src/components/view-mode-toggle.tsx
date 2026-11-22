"use client"

import * as React from "react"
import {
  BookOpenIcon,
  ChevronsUpDownIcon,
  FolderTreeIcon,
  GitBranchIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react"

import { ViewModeList } from "@/components/on-demand"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useFilesPanel, type ViewMode } from "@/components/files-panel"
import { IconButton, isCommandKey, shortcut, useIsMac } from "@/components/topbar/primitives"
import { cn } from "@/lib/utils"

/**
 * How many tabs a view can hold before a close-all button appears. Below it
 * closing them one by one is quicker than finding the button.
 */
const CLOSE_ALL_AT = 10

export type Mode = { id: ViewMode; label: string; icon: typeof MessageSquareIcon }

const CHAT: Mode = { id: "chat", label: "Chat", icon: MessageSquareIcon }
const FILES: Mode = { id: "file", label: "Files", icon: FolderTreeIcon }
const DOCS: Mode = { id: "docs", label: "Knowledge", icon: BookOpenIcon }
const TERMINAL: Mode = { id: "terminal", label: "Terminal", icon: SquareTerminalIcon }
const GIT: Mode = { id: "git", label: "Git", icon: GitBranchIcon }

/**
 * A project's tabs. No Files tab: the Files button at the right of the bar
 * opens the tree, and opening a file shows the editor -- the tab only
 * repeated that. Its place goes to the project's documentation, read
 * without leaving the session.
 */
const MODES = [CHAT, DOCS, TERMINAL, GIT]

/**
 * A session is a chat with a working directory: no Git tab, and no project
 * whose documentation there would be to read.
 */
const SESSION_MODES = [CHAT, FILES, TERMINAL]

/** Every view, for naming the one on screen when it has no tab of its own. */
const ALL_MODES = [CHAT, FILES, DOCS, TERMINAL, GIT]

/**
 * Which of the project's views is on screen: a segmented control in the
 * middle of the top bar, with a pill that slides to the lit tab.
 *
 * ⌘1-⌘4 (Ctrl elsewhere) pick a tab from anywhere, and the arrow keys move
 * between them once one has focus. Labels fold away when the bar is narrow,
 * leaving the icons, and narrower still the row becomes one picker, since
 * the bar has the run buttons to fit beside it too. Measured on the bar
 * (`@container`), not the window: an open sidebar takes its share.
 */
export function ViewModeToggle({ session = false, gitChanges = 0 }: { session?: boolean; gitChanges?: number }) {
  const { mode, setMode, tabs, closeAllTabs, terminals } = useFilesPanel()
  const modes = session ? SESSION_MODES : MODES
  const mac = useIsMac()

  // The view is remembered across projects, so arriving in a session from a
  // project's Git or Knowledge view would otherwise show a tab that is
  // not offered here.
  React.useEffect(() => {
    if (session && (mode === "git" || mode === "docs")) setMode("chat")
  }, [session, mode, setMode])

  // ⌘1..⌘n, wherever focus is: the tabs are the page's own top level.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandKey(event) || event.defaultPrevented) return
      const index = Number(event.key) - 1
      const target = Number.isInteger(index) ? modes[index] : undefined
      if (!target) return
      event.preventDefault()
      setMode(target.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [modes, setMode])

  // The sweep acts on the view you are in: the file tabs when reading files,
  // the shells when in the terminal. Nothing to sweep in the chat.
  const sweep =
    mode === "file" && tabs.length > CLOSE_ALL_AT
      ? { label: `Close all ${tabs.length} files`, run: closeAllTabs }
      : mode === "terminal" && terminals.count > CLOSE_ALL_AT
        ? { label: `Close all ${terminals.count} terminals`, run: terminals.closeAll }
        : null

  return (
    <div className="flex items-center gap-1">
      <ViewModeSelect modes={modes} mode={mode} onChange={setMode} gitChanges={gitChanges} />
      <SegmentedTabs modes={modes} mode={mode} onChange={setMode} gitChanges={gitChanges} mac={mac} />

      {/* Beside the switcher rather than in it: the switcher is where you
          are, and this throws things away. Only once there are enough tabs
          that closing them singly is a chore. */}
      {sweep && (
        <IconButton label={sweep.label} onClick={sweep.run} className="hover:text-danger">
          <Trash2Icon />
        </IconButton>
      )}
    </div>
  )
}

function SegmentedTabs({
  modes,
  mode,
  onChange,
  gitChanges,
  mac,
}: {
  modes: readonly Mode[]
  mode: ViewMode
  onChange: (mode: ViewMode) => void
  gitChanges: number
  mac: boolean
}) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({})
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null)
  // No slide into place on the first paint, only between tabs after it.
  const [settled, setSettled] = React.useState(false)
  const activeIndex = modes.findIndex((m) => m.id === mode)

  // Measured from the lit tab itself: its width moves with the git count,
  // and with the labels folding at `lg` -- which the observer catches.
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const tab = activeIndex >= 0 ? tabRefs.current[modes[activeIndex]!.id] : null
      setPill(tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [activeIndex, modes, gitChanges])

  React.useEffect(() => {
    if (!pill || settled) return
    const frame = requestAnimationFrame(() => setSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [pill, settled])

  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    const edge = event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : null
    if (!step && edge === null) return
    event.preventDefault()
    const from = activeIndex >= 0 ? activeIndex : 0
    const next = modes[edge ?? (from + step + modes.length) % modes.length]!
    onChange(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Project view"
      onKeyDown={onKeyDown}
      className="bg-muted/60 light:bg-sidebar relative hidden items-center rounded-[10px] p-[3px] @xl:flex"
    >
      {pill && (
        <span
          aria-hidden
          className={cn(
            "border-border bg-background light:border-border-strong light:shadow-rest dark:bg-foreground/[0.08] absolute top-[3px] bottom-[3px] rounded-[7px] border shadow-xs",
            settled && "transition-[left,width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {modes.map(({ id, label, icon: Icon }, index) => {
        const selected = mode === id
        const count = id === "git" && gitChanges > 0 ? gitChanges : 0
        return (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            // One stop in the tab order: the lit tab, or the first when none is.
            tabIndex={selected || (activeIndex < 0 && index === 0) ? 0 : -1}
            title={`${label}  ${shortcut(mac, String(index + 1))}`}
            aria-keyshortcuts={mac ? `Meta+${index + 1}` : `Control+${index + 1}`}
            onClick={() => onChange(id)}
            className={cn(
              "focus-visible:ring-focus-ring/60 relative z-10 flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {/* Icons only until the bar is 60rem wide -- the bar's width,
                not the window's, since the sidebar takes its share. */}
            <span className="sr-only @min-[60rem]:not-sr-only">{label}</span>
            {count > 0 && (
              <span className="bg-warning/15 text-warning rounded-full px-1.5 text-[10px] leading-4 font-semibold tabular-nums">
                <span className="sr-only">, </span>
                {count}
                <span className="sr-only"> changed</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The tabs as one picker, for screens too narrow for the row. */
function ViewModeSelect({
  modes,
  mode,
  onChange,
  gitChanges,
}: {
  modes: readonly Mode[]
  mode: ViewMode
  onChange: (mode: ViewMode) => void
  gitChanges: number
}) {
  const [open, setOpen] = React.useState(false)
  // Files has no tab in a project, but the tree still opens the editor.
  const current = ALL_MODES.find((m) => m.id === mode) ?? modes[0]!
  const CurrentIcon = current.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label={`Project view: ${current.label}`}
            className="bg-muted/60 light:bg-sidebar text-foreground focus-visible:ring-focus-ring/60 relative flex h-8 items-center gap-1 rounded-[10px] px-2 outline-none focus-visible:ring-2 @xl:hidden"
          />
        }
      >
        <CurrentIcon className="size-3.5 shrink-0" />
        {gitChanges > 0 && mode !== "git" && !modes.every((m) => m.id !== "git") && (
          <span aria-hidden className="bg-warning absolute top-1 right-5 size-1.5 rounded-full" />
        )}
        <ChevronsUpDownIcon className="text-text-subtle size-3 shrink-0" />
      </PopoverTrigger>

      <PopoverContent className="w-44 p-0">
        <ViewModeList
          modes={modes}
          mode={mode}
          onSelect={(id) => {
            onChange(id)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
