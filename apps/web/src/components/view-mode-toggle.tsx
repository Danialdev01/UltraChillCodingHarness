"use client"

import { FolderTreeIcon, GitBranchIcon, MessageSquareIcon, SquareTerminalIcon, Trash2Icon } from "lucide-react"

import { SidebarToggles } from "@/components/file-explorer-toggle"
import { useFilesPanel, type ViewMode } from "@/components/files-panel"
import { cn } from "@/lib/utils"

/**
 * How many tabs a view can hold before a close-all button appears. Below it
 * closing them one by one is quicker than finding the button.
 */
const CLOSE_ALL_AT = 10

const MODES: { id: ViewMode; label: string; icon: typeof MessageSquareIcon }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareIcon },
  { id: "file", label: "Files", icon: FolderTreeIcon },
  { id: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { id: "git", label: "Git", icon: GitBranchIcon },
]

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
 */
export function ViewModeToggle() {
  const { mode, setMode, tabs, closeAllTabs, terminals } = useFilesPanel()

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
      <div className="bg-muted/40 flex items-center gap-0.5 rounded-lg border p-0.5">
        <div role="tablist" aria-label="Project view" className="flex items-center gap-0.5">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                mode === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        <SidebarToggles />
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
