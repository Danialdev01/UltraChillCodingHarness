"use client"

import * as React from "react"
import {
  ChevronsUpDownIcon,
  FolderTreeIcon,
  GitBranchIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
  StickyNoteIcon,
  Trash2Icon,
} from "lucide-react"

import { SidebarToggles } from "@/components/file-explorer-toggle"
import { Button } from "@/components/ui/button"
import { ViewModeList } from "@/components/on-demand"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useFilesPanel, type ViewMode } from "@/components/files-panel"
import { cn } from "@/lib/utils"

/**
 * How many tabs a view can hold before a close-all button appears. Below it
 * closing them one by one is quicker than finding the button.
 */
const CLOSE_ALL_AT = 10

export type Mode = { id: ViewMode; label: string; icon: typeof MessageSquareIcon }

const CHAT: Mode = { id: "chat", label: "Chat", icon: MessageSquareIcon }
const FILES: Mode = { id: "file", label: "Files", icon: FolderTreeIcon }
const DOCS: Mode = { id: "docs", label: "Knowledge", icon: StickyNoteIcon }
const TERMINAL: Mode = { id: "terminal", label: "Terminal", icon: SquareTerminalIcon }
const GIT: Mode = { id: "git", label: "Git", icon: GitBranchIcon }

/**
 * A project's tabs. No Files tab: the tree toggle beside them opens the
 * files, and opening one shows the editor -- the tab only repeated that.
 * Its place goes to the project's documentation, read without leaving the
 * session.
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
 * Which of the project's three views is on screen, and what is beside it.
 *
 * A segmented toggle rather than a button that renames itself: with two views
 * the old button could say where it would take you, and with three it could
 * not -- and even with two, "Files" on screen while you are *in* the chat is
 * a label that has to be read twice. Here all three are visible and the lit
 * one is where you are.
 *
 * The two sidebar toggles sit inside the same pill, at its right end behind a
 * divider. They are a different kind of control -- a state, not a destination --
 * which is what the divider says; but they act on what the three tabs choose,
 * so putting them in the group keeps the header to one cluster of controls
 * instead of two that look alike.
 *
 * On a phone the four tabs do not fit beside everything else in the header,
 * so they fold into a picker shaped like the harness one in the chat.
 */
export function ViewModeToggle({ session = false }: { session?: boolean }) {
  const { mode, setMode, tabs, closeAllTabs, terminals } = useFilesPanel()
  const modes = session ? SESSION_MODES : MODES

  // The view is remembered across projects, so arriving in a session from a
  // project's Git or Knowledge view would otherwise show a tab that is
  // not offered here.
  React.useEffect(() => {
    if (session && (mode === "git" || mode === "docs")) setMode("chat")
  }, [session, mode, setMode])

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
      <ViewModeSelect modes={modes} mode={mode} onChange={setMode} />

      <div className="bg-muted/40 hidden items-center gap-0.5 rounded-lg border p-0.5 md:flex">
        <div role="tablist" aria-label="Project view" className="flex items-center gap-0.5">
          {modes.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              title={label}
              onClick={() => setMode(id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                mode === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {/* Icons only until lg: beside a full sidebar, the labelled
                  row left the page title a few letters. */}
              <span className="sr-only lg:not-sr-only">{label}</span>
            </button>
          ))}
        </div>

        <SidebarToggles session={session} />
      </div>

      {/* Outside the pill: the pill is where you are and what is beside it,
          and this throws things away. Only once there are enough tabs that
          closing them singly is a chore. */}
      {sweep && (
        <button
          type="button"
          title={sweep.label}
          onClick={sweep.run}
          className="text-muted-foreground hover:text-destructive flex size-7 items-center justify-center rounded-md transition-colors"
        >
          <Trash2Icon className="size-3.5" />
          <span className="sr-only">{sweep.label}</span>
        </button>
      )}
    </div>
  )
}

/** The tabs as one picker, for screens too narrow for the row. */
function ViewModeSelect({
  modes,
  mode,
  onChange,
}: {
  modes: readonly Mode[]
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  const [open, setOpen] = React.useState(false)
  // Files has no tab in a project, but the tree still opens the editor.
  const current = ALL_MODES.find((m) => m.id === mode) ?? modes[0]!
  const CurrentIcon = current.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Project view"
            className="h-8 w-32 justify-between px-2 text-xs font-normal md:hidden"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <CurrentIcon className="size-3.5 shrink-0" />
          <span className="truncate">{current.label}</span>
        </span>
        <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
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
