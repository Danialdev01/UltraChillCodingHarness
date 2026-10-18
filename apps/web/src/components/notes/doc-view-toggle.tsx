"use client"

import * as React from "react"
import { SettingsIcon } from "lucide-react"

import { NoteSettingsDialog } from "@/components/notes/note-settings-dialog"
import { DOC_VIEWS, type DocView } from "@/lib/sections"
import { cn } from "@/lib/utils"

/**
 * The documentation's own bar, across the top of its page: which of its
 * views is open, and the settings beside them.
 *
 * Inside the page rather than in the app header, because the documentation
 * is also a view of a project session, whose header already holds the
 * session's own tabs. Where the choice goes is the workspace's business --
 * `?view=` on the documentation route, local state in a session -- so this
 * only reports it.
 */
export function DocViewTabs({
  projectHash,
  view,
  onSelect,
}: {
  projectHash: string
  view: DocView
  onSelect(view: DocView): void
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
      <div
        role="tablist"
        aria-label="Documentation view"
        className="bg-muted/40 flex items-center gap-0.5 overflow-x-auto rounded-lg border p-0.5"
      >
        {DOC_VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => onSelect(id)}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-md px-2 text-xs transition-colors",
              view === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        title="Documentation settings"
        onClick={() => setSettingsOpen(true)}
        className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
      >
        <SettingsIcon className="size-3.5" />
        <span className="sr-only">Documentation settings</span>
      </button>
      <NoteSettingsDialog hash={projectHash} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
