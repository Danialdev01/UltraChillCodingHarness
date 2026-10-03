"use client"

import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { useNotes } from "@/components/notes/notes-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { NoteSummary } from "@/lib/notes-api"
import { dropZoneAt, resolveNoteDrop, type DropZone } from "@/lib/note-drop"
import { buildNoteTree, childrenOf, titleOrUntitled, type NoteTree } from "@/lib/note-tree"
import { cn } from "@/lib/utils"

interface TreeActions {
  onCreate(parentId: string, title?: string): Promise<NoteSummary>
  onDelete(id: string): Promise<void>
  onMove(id: string, to: { parentId: string; position: number }): Promise<void>
}

const DRAG_TYPE = "application/x-ucch-note"

/**
 * One drag, for the whole tree: which page is moving (the browser keeps the
 * transfer's data to itself until the drop), and which row it is over.
 */
interface DragState {
  draggingId: string | null
  setDraggingId(id: string | null): void
  over: { id: string; zone: DropZone } | null
  setOver(next: { id: string; zone: DropZone } | null): void
}
const DragContext = React.createContext<DragState>({
  draggingId: null,
  setDraggingId: () => {},
  over: null,
  setOver: () => {},
})

/**
 * The page tree, at the right of the page so the writing keeps the left.
 *
 * Every row is a link; the arrow folds its children and the trailing menu
 * holds what a row can do. New pages go under the row they were made from,
 * and open at once -- a page with no name yet is one you are about to name.
 * Rows drag: onto the edge of another to reorder, onto its middle to nest.
 */
export function NoteTreeSidebar({
  projectName,
  error,
  ...actions
}: TreeActions & { projectName: string; error: string | null }) {
  const { notes, rootId } = useNotes()
  const tree = React.useMemo(() => buildNoteTree(notes), [notes])
  const [over, setOver] = React.useState<DragState["over"]>(null)
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const drag = React.useMemo(
    () => ({ over, setOver, draggingId, setDraggingId }),
    [over, draggingId],
  )

  return (
    <aside className="bg-sidebar/40 flex w-60 shrink-0 flex-col border-l">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <span className="text-muted-foreground truncate text-[11px] font-medium tracking-wide uppercase">
          Pages
        </span>
        {rootId && <NewPageButton parentId={rootId} {...actions} />}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onDragEnd={() => {
          setOver(null)
          setDraggingId(null)
        }}
      >
        {error ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">{error}</p>
        ) : tree ? (
          <DragContext.Provider value={drag}>
            <TreeRow node={{ ...tree, title: tree.title || projectName }} depth={0} {...actions} />
          </DragContext.Provider>
        ) : (
          <p className="text-muted-foreground px-3 py-2 text-xs">Loading…</p>
        )}
      </div>
    </aside>
  )
}

function NewPageButton({ parentId, onCreate }: { parentId: string } & Pick<TreeActions, "onCreate">) {
  const { open } = useNotes()
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title="New page"
      disabled={busy}
      onClick={async (event) => {
        event.stopPropagation()
        setBusy(true)
        try {
          const page = await onCreate(parentId)
          open(page.id)
        } finally {
          setBusy(false)
        }
      }}
    >
      <PlusIcon />
    </Button>
  )
}

function TreeRow({ node, depth, ...actions }: TreeActions & { node: NoteTree; depth: number }) {
  const { activeId, open, notes, rootId } = useNotes()
  const { over, setOver, draggingId, setDraggingId } = React.useContext(DragContext)
  const [collapsed, setCollapsed] = React.useState(false)
  const expandTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = node.id === activeId
  const isRoot = node.parentId === null
  const siblings = node.parentId ? childrenOf(notes, node.parentId) : []
  const index = siblings.findIndex((s) => s.id === node.id)
  const zone = over?.id === node.id ? over.zone : null

  const clearExpand = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current)
    expandTimer.current = null
  }

  return (
    <div>
      <div
        role="link"
        tabIndex={0}
        draggable={!isRoot}
        onClick={() => open(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") open(node.id)
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, node.id)
          event.dataTransfer.effectAllowed = "move"
          setDraggingId(node.id)
        }}
        onDragOver={(event) => {
          if (!draggingId || !event.dataTransfer.types.includes(DRAG_TYPE)) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const next = dropZoneAt(event.clientY - rect.top, rect.height, { canReorder: !isRoot })
          const allowed = resolveNoteDrop(notes, draggingId, node.id, next) !== null
          event.dataTransfer.dropEffect = allowed ? "move" : "none"
          if (!allowed) {
            setOver(null)
            return
          }
          if (zone !== next) setOver({ id: node.id, zone: next })
          // Hovering the middle of a folded row for a moment opens it.
          if (next === "inside" && collapsed && !expandTimer.current) {
            expandTimer.current = setTimeout(() => setCollapsed(false), 600)
          } else if (next !== "inside") clearExpand()
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          clearExpand()
          if (zone) setOver(null)
        }}
        onDrop={(event) => {
          const draggedId = event.dataTransfer.getData(DRAG_TYPE) || draggingId
          clearExpand()
          setOver(null)
          setDraggingId(null)
          if (!draggedId) return
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const dropZone = dropZoneAt(event.clientY - rect.top, rect.height, { canReorder: !isRoot })
          const to = resolveNoteDrop(notes, draggedId, node.id, dropZone)
          if (!to) return
          if (dropZone === "inside") setCollapsed(false)
          void actions.onMove(draggedId, to)
        }}
        data-drop={zone ?? undefined}
        className={cn(
          "group/row ucch-tree-row relative flex h-7 cursor-pointer items-center gap-1 pr-1 text-sm",
          active
            ? "bg-ucch-active-bg text-ucch-active"
            : "text-foreground/80 hover:bg-muted hover:text-foreground",
          zone === "inside" && "ring-ucch-active bg-ucch-active-bg/60 ring-1 ring-inset",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          className={cn(
            "text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded",
            node.children.length === 0 && "invisible",
          )}
          onClick={(event) => {
            event.stopPropagation()
            setCollapsed((c) => !c)
          }}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        <span className="w-4 shrink-0 text-center text-[13px] leading-none">
          {node.icon ?? <FileTextIcon className="text-muted-foreground inline size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{titleOrUntitled(node.title)}</span>
        <span className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" title="Page actions" />}
              onClick={(event: React.MouseEvent) => event.stopPropagation()}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem
                onClick={async () => {
                  const page = await actions.onCreate(node.id)
                  setCollapsed(false)
                  open(page.id)
                }}
              >
                <PlusIcon /> Add sub-page
              </DropdownMenuItem>
              {!isRoot && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={index <= 0}
                    onClick={() =>
                      actions.onMove(node.id, { parentId: node.parentId!, position: index - 1 })
                    }
                  >
                    <ArrowUpIcon /> Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === -1 || index >= siblings.length - 1}
                    onClick={() =>
                      actions.onMove(node.id, { parentId: node.parentId!, position: index + 1 })
                    }
                  >
                    <ArrowDownIcon /> Move down
                  </DropdownMenuItem>
                  {node.parentId !== rootId && rootId && (
                    <DropdownMenuItem
                      onClick={() =>
                        actions.onMove(node.id, {
                          parentId: rootId,
                          position: childrenOf(notes, rootId).length,
                        })
                      }
                    >
                      <ArrowUpIcon className="-rotate-45" /> Move to top level
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(node.id)}>
                    <Trash2Icon /> Delete page
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {!collapsed &&
        node.children.map((child) => (
          <TreeRow key={child.id} node={child} depth={depth + 1} {...actions} />
        ))}
    </div>
  )
}
