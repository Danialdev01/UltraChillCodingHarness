"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { LibraryBigIcon } from "lucide-react"

import { DiagramsView } from "@/components/diagrams/diagrams-view"
import { KeysWorkspace } from "@/components/keys/keys-workspace"
import { DocViewTabs } from "@/components/notes/doc-view-toggle"
import { NoteEditor } from "@/components/notes/note-editor"
import { NotesProvider, type NotesContextValue } from "@/components/notes/notes-context"
import { NoteTreeSidebar } from "@/components/notes/note-tree-sidebar"
import { NoteBreadcrumb } from "@/components/notes/note-breadcrumb"
import { NoteSearchDialog } from "@/components/notes/note-search-dialog"
import { PresenceBadge } from "@/components/presence-badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  NoteMoveConflictError,
  createNote,
  deleteNote,
  fetchNote,
  moveNote,
  type Note,
  type NoteSummary,
} from "@/lib/notes-api"
import {
  isOwnChange,
  othersAt,
  usePresence,
  usePresenceLocation,
  useProjectEvents,
  useToast,
} from "@/lib/realtime"
import { DEFAULT_DOC_WIDTH, docMaxWidth, readDocWidth, watchDocWidth } from "@/lib/doc-width"
import { docViewFromParam, noteHref, noteIdFromPath, type DocView } from "@/lib/sections"
import { useCachedState } from "@/lib/queries/cached-state"
import { useProject } from "@/lib/queries/project"
import { projectQueries } from "@/lib/queries/project-data"
import { useWorkspaceHash } from "@/lib/workspace-context"
import type { Project } from "@/lib/session"
import { useTransitionRouter } from "@/lib/view-transitions"

/** Which page of the notes is open (null for the root), and which view. */
export interface DocLocation {
  noteId: string | null
  view: DocView
}

/**
 * A project's notes: the page tree on the left, one page open on the right.
 *
 * On the documentation route the URL says which page is open (null for the
 * root), and it is read from the URL here rather than passed in: the notes
 * layout renders this once and keeps it mounted across `/notes/{id}`
 * navigations, so the tree survives a click on a row and only the editor
 * changes. In a project session it is one of the session's views instead,
 * on the session's own URL, so `location` is passed in and every move is
 * handed back through `onLocationChange` rather than navigated to. This component owns the tree
 * and the open page's record. The editor is keyed by page id, so moving
 * between pages remounts it with the new document rather than swapping
 * content under a live cursor -- and its autosave flushes on the way out.
 */
export function NotesWorkspace({
  project: seed,
  location,
  onLocationChange,
}: {
  project: Project
  location?: DocLocation
  onLocationChange?(next: DocLocation): void
}) {
  const project = useProject(seed.hash) ?? seed
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const pathNoteId = noteIdFromPath(usePathname())
  const paramView = docViewFromParam(useSearchParams().get("view"))
  const noteId = location ? location.noteId : pathNoteId
  const view = location ? location.view : paramView
  // The page tree, cached: coming back to the documentation shows it at once.
  const treeQuery = projectQueries.notesTree(project.hash)
  const [tree, setTree, reloadTree, treeState] = useCachedState(treeQuery.queryKey, treeQuery.queryFn, {
    persist: treeQuery.persist,
  })
  const notes = React.useMemo(() => tree?.notes ?? [], [tree])
  const rootId = tree?.rootId || null
  const setNotes = React.useCallback(
    (update: NoteSummary[] | ((current: NoteSummary[]) => NoteSummary[])) =>
      setTree((current) => ({
        rootId: current?.rootId ?? "",
        notes: typeof update === "function" ? update(current?.notes ?? []) : update,
      })),
    [setTree],
  )
  const treeError = treeState.error ? treeState.error.message || "Could not load the notes." : null
  const [note, setNote] = React.useState<Note | null>(null)
  const [noteError, setNoteError] = React.useState<string | null>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [treeOpen, setTreeOpen] = React.useState(true)
  const docWidth = useDocWidth()

  // ⌘P / Ctrl+P finds a page, wherever focus is; the browser's print
  // dialog is not what anyone wants from inside a notebook.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "p" || !(event.metaKey || event.ctrlKey) || event.shiftKey) return
      event.preventDefault()
      setSearchOpen((previous) => !previous)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const activeId = noteId ?? rootId

  /**
   * Opens a page (and with it the Notes view), or another view. On the route
   * that is a navigation: Notes is the bare page URL, the others hang off
   * the root as `?view=`, since they are not per page.
   */
  const go = React.useCallback(
    (next: { noteId: string | null } | { view: DocView }) => {
      if (location && onLocationChange) {
        onLocationChange("view" in next ? { ...location, view: next.view } : { noteId: next.noteId, view: "notes" })
        return
      }
      if ("view" in next && next.view !== "notes") {
        router.push(`${noteHref(ws, project.hash, null)}?view=${next.view}`)
        return
      }
      const id = "noteId" in next ? next.noteId : noteId
      router.push(noteHref(ws, project.hash, id, rootId ?? undefined))
    },
    [location, onLocationChange, router, ws, project.hash, noteId, rootId],
  )

  const refreshTree = reloadTree

  // The open page, fetched whenever the URL (or the root, once known) changes.
  React.useEffect(() => {
    if (!activeId) return
    let cancelled = false
    setNote(null)
    setNoteError(null)
    fetchNote(project.hash, activeId).then(
      (loaded) => {
        if (!cancelled) setNote(loaded)
      },
      (error: unknown) => {
        if (!cancelled) setNoteError(error instanceof Error ? error.message : "Could not open that page.")
      },
    )
    return () => {
      cancelled = true
    }
  }, [project.hash, activeId])

  // Other tabs, and other people. An update carries what it wrote, so the
  // tree row and the open page take it as it lands -- the editor decides
  // whether to apply it, not under a pending edit of its own. Anything else
  // reshapes the tree, which is refetched whole. This tab's own changes are
  // already on screen and are skipped.
  const toast = useToast()
  const activeRef = React.useRef(activeId)
  activeRef.current = activeId
  const notesRef = React.useRef(notes)
  notesRef.current = notes

  useProjectEvents(project.id, (event) => {
    if (event.type !== "note.changed" || isOwnChange(event.origin)) return

    if (event.change === "updated" && event.fields) {
      // The body is not taken from here: the open page shares it live
      // through the collab service, which is also what saved it.
      const { content: _content, contentOmitted: _contentOmitted, ...summary } = event.fields
      setNotes((current) =>
        current.map((n) => (n.id === event.noteId ? { ...n, ...summary, updatedAt: event.updatedAt } : n)),
      )
      setNote((current) =>
        current && current.id === event.noteId ? { ...current, ...summary, updatedAt: event.updatedAt } : current,
      )
      return
    }

    if (event.change === "deleted") {
      const open = activeRef.current
      if (open && (open === event.noteId || isUnder(notesRef.current, open, event.noteId))) {
        const title = notesRef.current.find((n) => n.id === event.noteId)?.title
        toast({
          tone: "error",
          title: `“${title ?? "This page"}” was deleted in another window`,
          description: "Moved you to the page it was under.",
        })
        go({ noteId: event.parentId ?? null })
      }
    }
    void refreshTree()
  })

  // Where this tab is, so the others can show it; and who else is here.
  const [editing, setEditing] = React.useState(false)
  usePresenceLocation(project.id, activeId ? `note:${activeId}` : null, editing)
  const viewers = usePresence(project.id)
  const others = activeId ? othersAt(viewers, `note:${activeId}`) : []

  const open = React.useCallback((id: string) => go({ noteId: id }), [go])
  const href = React.useCallback(
    (id: string) => (location ? null : noteHref(ws, project.hash, id, rootId ?? undefined)),
    [location, ws, project.hash, rootId],
  )

  const createPage = React.useCallback(
    async (parentId: string, title?: string) => {
      const created = await createNote(project.hash, { parentId, title })
      const { content: _content, createdAt: _createdAt, ...summary } = created
      setNotes((current) => [...current, summary])
      return summary
    },
    [project.hash],
  )

  const removePage = React.useCallback(
    async (id: string) => {
      await deleteNote(project.hash, id)
      // Everything under it went with it on the server; drop the same here
      // rather than wait for a refetch, then confirm with one.
      setNotes((current) => {
        const gone = new Set<string>([id])
        let grew = true
        while (grew) {
          grew = false
          for (const n of current) {
            if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) {
              gone.add(n.id)
              grew = true
            }
          }
        }
        return current.filter((n) => !gone.has(n.id))
      })
      if (activeId === id || (note && isUnder(notes, note.id, id))) {
        go({ noteId: null })
      }
      void refreshTree()
    },
    [project.hash, activeId, note, notes, go, refreshTree],
  )

  const movePage = React.useCallback(
    async (id: string, to: { parentId: string; position: number }) => {
      // Moved from where this tab last saw it; if another window has moved it
      // since, the server refuses and the tree snaps to where it really is.
      const from = notesRef.current.find((n) => n.id === id)?.parentId ?? undefined
      try {
        setNotes(await moveNote(project.hash, id, { ...to, ...(from ? { ifParentId: from } : {}) }))
      } catch (error) {
        if (!(error instanceof NoteMoveConflictError)) throw error
        setNotes(error.notes)
        toast({
          tone: "error",
          title: "That page was moved in another window",
          description: "Your move was reverted; the tree shows where it is now.",
        })
      }
    },
    [project.hash, toast],
  )

  /** The editor's own writes, mirrored into the tree so the row keeps up. */
  const patchSummary = React.useCallback((id: string, patch: Partial<NoteSummary>) => {
    setNotes((current) => current.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }, [])

  const context = React.useMemo<NotesContextValue>(
    () => ({ hash: project.hash, notes, rootId, activeId, createPage, open, href }),
    [project.hash, notes, rootId, activeId, createPage, open, href],
  )

  const notesView = (
    <NotesProvider value={context}>
      {/* The page's width, from Preferences, as a variable the editor, its
          placeholder and the skeleton below all read. */}
      <div
        className="flex min-h-0 flex-1"
        style={{ "--ucch-doc-width": docMaxWidth(docWidth) } as React.CSSProperties}
      >
        <NoteSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NoteBreadcrumb
            noteId={activeId}
            treeOpen={treeOpen}
            onToggleTree={() => setTreeOpen((open) => !open)}
            onSearch={() => setSearchOpen(true)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {noteError ? (
              <p className="text-muted-foreground p-8 text-sm">{noteError}</p>
            ) : note && note.id === activeId ? (
              <NoteEditor
                key={note.id}
                hash={project.hash}
                note={note}
                onSummaryChange={(patch) => patchSummary(note.id, patch)}
                onEditingChange={setEditing}
                presence={<PresenceBadge others={others} />}
              />
            ) : (
              <NotePageSkeleton />
            )}
          </div>
        </div>
        {/* Kept mounted and slid shut, the way the app's own sidebar folds:
            the width animates, and what is inside keeps its scroll and state. */}
        <div
          data-state={treeOpen ? "open" : "closed"}
          aria-hidden={!treeOpen}
          className="flex w-60 shrink-0 overflow-hidden transition-[width] duration-200 ease-linear data-[state=closed]:w-0"
        >
          <NoteTreeSidebar
            projectName={project.name}
            onCreate={createPage}
            onDelete={removePage}
            onMove={movePage}
            error={treeError}
          />
        </div>
      </div>
    </NotesProvider>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocViewTabs projectHash={project.hash} view={view} onSelect={(next) => go({ view: next })} />
      {/* The tree is held above the views, so it survives another view
          being up and coming back to Notes does not refetch it. */}
      {view === "diagrams" ? (
        <DiagramsView project={project} />
      ) : view === "references" ? (
        <ReferencesPlaceholder />
      ) : view === "keys" ? (
        <KeysWorkspace project={project} />
      ) : (
        notesView
      )}
    </div>
  )
}

/**
 * The page width chosen in the project's Preferences. Read after mount, like
 * the font sizes, so the first paint matches the server's.
 */
function useDocWidth() {
  const [width, setWidth] = React.useState(DEFAULT_DOC_WIDTH)
  React.useEffect(() => {
    setWidth(readDocWidth())
    return watchDocWidth(setWidth)
  }, [])
  return width
}

/** Whether `id` is `ancestorId` or somewhere below it. */
function isUnder(notes: readonly NoteSummary[], id: string, ancestorId: string): boolean {
  const parentOf = new Map(notes.map((n) => [n.id, n.parentId]))
  let current: string | null | undefined = id
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = parentOf.get(current)
  }
  return false
}

/** References: a real view from the switcher, not built yet. */
function ReferencesPlaceholder() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <LibraryBigIcon className="text-muted-foreground size-4" />
          References
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">
          Links, specs and outside material this project relies on. Arrives with references.
        </p>
      </div>
    </div>
  )
}

function NotePageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[var(--ucch-doc-width,48rem)] px-8 py-12">
      <Skeleton className="mb-6 h-9 w-2/5" />
      <Skeleton className="mb-3 h-4 w-full" />
      <Skeleton className="mb-3 h-4 w-11/12" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  )
}
