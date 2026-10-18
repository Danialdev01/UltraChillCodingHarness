"use client"

import * as React from "react"
import { PanelRightCloseIcon, PanelRightOpenIcon, SearchIcon } from "lucide-react"

import { useNotes } from "@/components/notes/notes-context"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { ancestorsOf, titleOrUntitled } from "@/lib/note-tree"
import type { NoteSummary } from "@/lib/notes-api"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * The notes' own top bar: where the open page sits in the tree, root first,
 * and at the right the controls for the page tree -- search, and the button
 * that shows or hides the column. The settings live in the documentation's
 * own bar above, beside the view switcher, since they cover all of it.
 *
 * The app header's crumb stops at "Documentation"; this one continues from there,
 * inside the page, because the tree is the notes' own business.
 */
export function NoteBreadcrumb({
  noteId,
  treeOpen,
  onToggleTree,
  onSearch,
}: {
  noteId: string | null
  treeOpen: boolean
  onToggleTree(): void
  onSearch(): void
}) {
  const { notes } = useNotes()
  const path = React.useMemo(() => (noteId ? ancestorsOf(notes, noteId) : []), [notes, noteId])

  return (
    <div className="flex h-10 items-center gap-2 border-b pr-2 pl-4">
      <div className="min-w-0 flex-1">
        {path.length > 0 && <Crumbs path={path} />}
      </div>
      <Button variant="ghost" size="icon-xs" title="Search pages (⌘P)" onClick={onSearch}>
        <SearchIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title={treeOpen ? "Hide pages" : "Show pages"}
        aria-pressed={treeOpen}
        onClick={onToggleTree}
      >
        {treeOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
      </Button>
    </div>
  )
}

function Crumbs({ path }: { path: NoteSummary[] }) {
  const { href, open } = useNotes()
  return (
    <div className="flex items-center">
      <Breadcrumb>
        <BreadcrumbList className="text-xs">
          {path.map((page, index) => {
            const last = index === path.length - 1
            const label = (
              <>
                {page.icon && <span className="mr-1">{page.icon}</span>}
                {titleOrUntitled(page.title)}
              </>
            )
            return (
              <React.Fragment key={page.id}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {last ? (
                    <BreadcrumbPage>{label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={
                        // Embedded in a session there is no page URL to
                        // link to; the page opens in place.
                        href(page.id) === null ? (
                          <button type="button" onClick={() => open(page.id)} />
                        ) : (
                          <TransitionLink href={href(page.id)!} />
                        )
                      }
                    >
                      {label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  )
}
