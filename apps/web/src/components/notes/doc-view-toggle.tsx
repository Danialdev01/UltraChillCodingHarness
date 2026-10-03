"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { SettingsIcon } from "lucide-react"

import { NoteSettingsDialog } from "@/components/notes/note-settings-dialog"
import { DOC_VIEWS, docViewFromParam, noteHref, type DocView } from "@/lib/sections"
import { cn } from "@/lib/utils"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * The documentation's controls in the app header: which of its three views
 * is open, and the settings beside them.
 *
 * The view is `?view=` on the URL rather than state, because the header and
 * the workspace are in different trees -- the URL is the one thing both
 * read -- and because a view you can link to is one you can come back to.
 * Notes is the default and drops the param, so plain `/notes` links still
 * land where they always did.
 */
export function DocViewToggle({ projectHash }: { projectHash: string }) {
  const router = useTransitionRouter()
  const pathname = usePathname()
  const view = docViewFromParam(useSearchParams().get("view"))
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const select = (id: DocView) => {
    // Keep the open page when going back to the notes; the other views are
    // not per page, so they hang off the root.
    const base = id === "notes" ? pathname : noteHref(projectHash, null)
    router.push(id === "notes" ? base : `${base}?view=${id}`)
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <div
        role="tablist"
        aria-label="Documentation view"
        className="bg-muted/40 flex items-center gap-0.5 rounded-lg border p-0.5"
      >
        {DOC_VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => select(id)}
            className={cn(
              "flex h-7 items-center rounded-md px-2 text-xs transition-colors",
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
        className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
      >
        <SettingsIcon className="size-3.5" />
        <span className="sr-only">Documentation settings</span>
      </button>
      <NoteSettingsDialog hash={projectHash} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}

