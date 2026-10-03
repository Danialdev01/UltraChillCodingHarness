"use client"

import * as React from "react"
import { FileTextIcon } from "lucide-react"

import { useNotes } from "@/components/notes/notes-context"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { mergeSearchHits, rankTitleMatches, type NoteSearchHit } from "@/lib/note-search"
import { ancestorsOf, titleOrUntitled } from "@/lib/note-tree"
import { searchNotes } from "@/lib/notes-api"

/**
 * Finding a page: by title as you type, from the tree already loaded, and
 * by what is written in it, from the server a moment later.
 *
 * The palette's own filtering is off: the list is already the answer, and
 * cmdk would otherwise hide a body hit whose title does not contain the
 * query.
 */
export function NoteSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const { hash, notes, open: openPage } = useNotes()
  const [query, setQuery] = React.useState("")
  const [bodyHits, setBodyHits] = React.useState<NoteSearchHit[]>([])
  const [searching, setSearching] = React.useState(false)

  const titleHits = React.useMemo(() => rankTitleMatches(notes, query), [notes, query])

  React.useEffect(() => {
    if (!open) {
      setQuery("")
      setBodyHits([])
    }
  }, [open])

  // The server is asked once typing pauses, and a reply that arrives after
  // the query moved on is dropped.
  React.useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setBodyHits([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      searchNotes(hash, q).then(
        (hits) => {
          if (cancelled) return
          setBodyHits(hits)
          setSearching(false)
        },
        () => {
          if (!cancelled) setSearching(false)
        },
      )
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hash, query])

  const hits = React.useMemo(
    () =>
      mergeSearchHits(
        titleHits.map((n) => ({ id: n.id, parentId: n.parentId, title: n.title, icon: n.icon })),
        bodyHits,
      ),
    [titleHits, bodyHits],
  )
  const titleIds = React.useMemo(() => new Set(titleHits.map((n) => n.id)), [titleHits])

  const pick = (id: string) => {
    onOpenChange(false)
    openPage(id)
  }

  const where = (id: string) => {
    const path = ancestorsOf(notes, id).slice(1, -1)
    return path.length ? path.map((n) => titleOrUntitled(n.title)).join(" / ") : null
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search pages"
      description="Find a page by its title or by what is written in it."
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput placeholder="Search pages…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>
          {query.trim().length < 2 ? "Type to search." : searching ? "Searching…" : "No pages match."}
        </CommandEmpty>
        {hits.filter((h) => titleIds.has(h.id)).length > 0 && (
          <CommandGroup heading="Pages">
            {hits
              .filter((h) => titleIds.has(h.id))
              .map((hit) => (
                <Hit key={hit.id} hit={hit} where={where(hit.id)} onSelect={() => pick(hit.id)} />
              ))}
          </CommandGroup>
        )}
        {hits.some((h) => !titleIds.has(h.id)) && (
          <CommandGroup heading="In page text">
            {hits
              .filter((h) => !titleIds.has(h.id))
              .map((hit) => (
                <Hit key={hit.id} hit={hit} where={where(hit.id)} onSelect={() => pick(hit.id)} />
              ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

function Hit({
  hit,
  where,
  onSelect,
}: {
  hit: NoteSearchHit
  where: string | null
  onSelect(): void
}) {
  return (
    <CommandItem value={hit.id} onSelect={onSelect} className="items-start">
      <span className="mt-0.5 w-4 shrink-0 text-center text-[13px] leading-none">
        {hit.icon ?? <FileTextIcon className="text-muted-foreground inline size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {titleOrUntitled(hit.title)}
          {where && <span className="text-muted-foreground ml-2 text-xs">{where}</span>}
        </span>
        {hit.snippet && (
          <span className="text-muted-foreground block truncate text-xs">{hit.snippet}</span>
        )}
      </span>
    </CommandItem>
  )
}
