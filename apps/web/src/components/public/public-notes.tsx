"use client"

import * as React from "react"
import { ChevronRightIcon, FileTextIcon } from "lucide-react"

import { NotesProvider, type NotesContextValue } from "@/components/notes/notes-context"
import { NoteReader } from "@/components/public/note-reader"
import { ListRowsSkeleton, NotePageSkeleton } from "@/components/page-skeletons"
import { childrenOf, findRoot, titleOrUntitled } from "@/lib/note-tree"
import type { Note, NoteSummary } from "@/lib/notes-api"
import { fetchPublicNote, fetchPublicNotes, publicHref } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

/**
 * The notes of a public site: the tree on the left, the open page beside it.
 *
 * `noteId` null means the root page. The tree is fetched once; the page
 * follows the URL. The notes context is provided so a linked-page block
 * inside a page can show its title and open it -- as a link on this site,
 * never as a new page, which the context refuses to make.
 */
export function PublicNotes({ slug, noteId }: { slug: string; noteId: string | null }) {
  const router = useTransitionRouter()
  const [notes, setNotes] = React.useState<NoteSummary[] | null>(null)
  const [note, setNote] = React.useState<Note | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchPublicNotes(slug).then(setNotes, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [slug])

  const rootId = React.useMemo(() => (notes ? findRoot(notes)?.id ?? null : null), [notes])
  const activeId = noteId ?? rootId

  React.useEffect(() => {
    if (!activeId) return
    let cancelled = false
    fetchPublicNote(slug, activeId).then(
      (loaded) => !cancelled && setNote(loaded),
      (e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load the page."),
    )
    return () => {
      cancelled = true
    }
  }, [slug, activeId])

  const context = React.useMemo<NotesContextValue>(
    () => ({
      hash: slug,
      notes: notes ?? [],
      rootId,
      activeId,
      createPage: () => Promise.reject(new Error("this site is read-only")),
      open: (id) => router.push(id === rootId ? publicHref(slug, "notes") : publicHref(slug, "notes", id)),
      href: (id) => (id === rootId ? publicHref(slug, "notes") : publicHref(slug, "notes", id)),
    }),
    [slug, notes, rootId, activeId, router],
  )

  return (
    <NotesProvider value={context}>
      <aside className="bg-sidebar/40 hidden w-64 shrink-0 flex-col overflow-y-auto border-r py-2 sm:flex">
        {notes && rootId ? (
          <PageTree notes={notes} parentId={rootId} rootId={rootId} slug={slug} activeId={activeId} depth={0} />
        ) : (
          <ListRowsSkeleton rows={5} className="flex flex-col gap-2 px-3 py-2" />
        )}
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="text-muted-foreground p-8 text-sm">{error}</p>
        ) : note && note.id === activeId ? (
          <NoteReader key={note.id} note={note} />
        ) : (
          <NotePageSkeleton />
        )}
      </div>
    </NotesProvider>
  )
}

/** The root and everything under it, each page a link, folders always open. */
function PageTree({
  notes,
  parentId,
  rootId,
  slug,
  activeId,
  depth,
}: {
  notes: NoteSummary[]
  parentId: string
  rootId: string
  slug: string
  activeId: string | null
  depth: number
}) {
  const rows = depth === 0 ? [notes.find((n) => n.id === parentId)!] : childrenOf(notes, parentId)
  return (
    <ul className="flex flex-col">
      {rows.map((page) => {
        const kids = childrenOf(notes, page.id)
        const active = page.id === activeId
        return (
          <li key={page.id}>
            <TransitionLink
              href={page.id === rootId ? publicHref(slug, "notes") : publicHref(slug, "notes", page.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 py-1 pr-3 text-xs",
                active ? "bg-ucch-active-bg text-ucch-active" : "text-muted-foreground hover:bg-muted/60",
              )}
              style={{ paddingLeft: 12 + depth * 14 }}
            >
              <span className="w-4 shrink-0 text-center text-[13px] leading-none">
                {page.icon ?? (
                  kids.length > 0 && depth > 0 ? (
                    <ChevronRightIcon className="text-muted-foreground inline size-3.5 rotate-90" />
                  ) : (
                    <FileTextIcon className="text-muted-foreground inline size-3.5" />
                  )
                )}
              </span>
              <span className="truncate">{titleOrUntitled(page.title)}</span>
            </TransitionLink>
            {kids.length > 0 && (
              <PageTree notes={notes} parentId={page.id} rootId={rootId} slug={slug} activeId={activeId} depth={depth + 1} />
            )}
          </li>
        )
      })}
    </ul>
  )
}
