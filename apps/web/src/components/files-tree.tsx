"use client"

import * as React from "react"
import {
  ChevronRightIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { FileTypeIcon } from "@/components/file-type-icon"
import { TreeRowsSkeleton } from "@/components/page-skeletons"
import { TREE_FONT_SIZE, treeMetricsStyle } from "@/lib/tree-font-size"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type { FileNode } from "@/lib/files-api"
import { movableInto } from "@/lib/file-drop"
import { DRAG_TYPE, useFilesPanel, type FilesPanelContextValue } from "@/components/files-panel"

/**
 * The tree's font size, from the browser preference, kept current while the
 * tree is open. The default until mount, so the server and the first paint
 * agree.
 */
function useTreeFontSize(): number {
  const [size, setSize] = React.useState(TREE_FONT_SIZE.defaultSize)
  React.useEffect(() => {
    setSize(TREE_FONT_SIZE.read())
    return TREE_FONT_SIZE.watch(setSize)
  }, [])
  return size
}

/**
 * The file tree: the sidebar's contents, not the sidebar itself.
 *
 * The column it sits in -- and the animation that brings it in -- belong to
 * `RightSidebar`, which it shares with the search panel. This is only the tree,
 * its toolbar, and the header naming the project.
 *
 * Its own module, loaded on demand (`on-demand.tsx`): the state it shows
 * lives in `FilesPanelProvider`, which every page needs, but the rows and
 * their drag-and-drop are needed only once the tree is opened.
 */
export function FilesTree() {
  const treeFontSize = useTreeFontSize()
  const {
    project,
    closeFiles,
    tree,
    treeLoading,
    treeLoaded,
    treeError,
    treeTruncated,
    refreshTree,
    creating,
    createTarget,
    beginCreate,
    selectedPaths,
    askDelete,
    dragging,
    dropTarget,
    setDropTarget,
    move,
  } = useFilesPanel()

  return (
    <>
      {/* h-10 matches the editor's tab strip, so the two line up across the
          page and their bottom borders read as one rule. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <FolderTreeIcon className="size-4 shrink-0" />
        <span className="flex-1 truncate text-sm font-medium">{project?.name ?? ""}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={refreshTree}
          title="Reload the file tree"
        >
          <RefreshCwIcon className={cn(treeLoading && "animate-spin")} />
          <span className="sr-only">Reload</span>
        </Button>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={closeFiles}>
          <XIcon />
          <span className="sr-only">Close files</span>
        </Button>
      </div>

        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          <span className="text-muted-foreground flex-1 truncate px-2 text-xs">
            {createTarget || "Project root"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => beginCreate("file")}
            title="New file"
          >
            <FilePlusIcon />
            <span className="sr-only">New file</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => beginCreate("folder")}
            title="New folder"
          >
            <FolderPlusIcon />
            <span className="sr-only">New folder</span>
          </Button>
        </div>

      {/* Focusable so the tree's keys have somewhere to land: a click on a
          row puts focus inside, and the key bubbles up here. Keeping the
          handler on the tree rather than the window means Delete in the
          editor stays an edit and Shift+F stays a capital F. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto outline-hidden",
          // VS Code's explorer density: every measure is a variable set below
          // from the font-size preference (`treeMetrics`), which at the 13px
          // default is a 22px row with a 16px icon. A row is exactly its line
          // tall, with nothing above or below it, so the hover and the
          // selection fill it edge to edge and rows sit flush. The weight stays
          // normal when selected, so picking a row never reflows its name.
          "[&_[data-sidebar=menu-button]]:h-(--tree-row-height) [&_[data-sidebar=menu-button]]:leading-(--tree-row-height) [&_[data-sidebar=menu-button]]:py-0 [&_[data-sidebar=menu-button]]:gap-0 [&_[data-sidebar=menu-button]]:rounded-none [&_[data-sidebar=menu-button]]:font-normal! [&_[data-sidebar=menu-button]]:text-(length:--tree-font-size)",
          // Nesting is drawn inside the row: its left padding grows by one
          // indent a level (the depth is set on the item), so rows still run
          // the sidebar's full width. Inset focus ring: the scroller would clip
          // one drawn outside a full-width row.
          "[&_[data-sidebar=menu-button]]:pr-(--tree-pad-x) [&_[data-sidebar=menu-button]]:pl-[calc(var(--tree-pad-x)+var(--tree-indent)*var(--ucch-tree-depth,0))] [&_[data-sidebar=menu-button]]:focus-visible:ring-inset",
          "[&_[data-sidebar=menu-button]_img]:size-(--tree-icon-size) [&_[data-sidebar=menu-button]_img]:mr-(--tree-gap-label) [&_[data-tree-chevron]_svg]:size-(--tree-chevron-glyph)",
          // A folder's children keep a faint guide line, under the folder's
          // chevron, now that the list itself is no longer indented.
          "[&_[data-sidebar=menu-sub]]:relative [&_[data-sidebar=menu-sub]]:m-0 [&_[data-sidebar=menu-sub]]:translate-x-0 [&_[data-sidebar=menu-sub]]:gap-0 [&_[data-sidebar=menu-sub]]:border-0 [&_[data-sidebar=menu-sub]]:p-0",
          "[&_[data-sidebar=menu-sub]]:before:pointer-events-none [&_[data-sidebar=menu-sub]]:before:absolute [&_[data-sidebar=menu-sub]]:before:inset-y-0 [&_[data-sidebar=menu-sub]]:before:z-10 [&_[data-sidebar=menu-sub]]:before:w-px [&_[data-sidebar=menu-sub]]:before:bg-sidebar-border [&_[data-sidebar=menu-sub]]:before:opacity-60 [&_[data-sidebar=menu-sub]]:before:left-[calc(var(--tree-pad-x)+var(--tree-indent)*var(--ucch-tree-depth,0)+var(--tree-chevron-size)/2)]",
          dropTarget === "" && "bg-ucch-active-bg/30",
        )}
        style={treeMetricsStyle(treeFontSize) as React.CSSProperties}
        tabIndex={0}
        // The tree itself is the root: a drop that no folder row claimed --
        // on a file, in a gap, on the empty space below -- lands at the top.
        {...dropHandlers({ folder: "", dragging, dropTarget, setDropTarget, move })}
        onKeyDown={(e) => {
          // The name input owns its own keys.
          if (e.target instanceof HTMLInputElement) return
          if (e.key === "Delete") {
            if (selectedPaths.size === 0) return
            e.preventDefault()
            askDelete([...selectedPaths])
            return
          }
          // Shift+F names a new folder, Alt+Shift+F a new file, where a
          // click on the toolbar button would: inside the selected folder, or
          // at the root. `code` rather than `key`: with Alt held some layouts
          // report a different character for the same physical key.
          if (e.code === "KeyF" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            beginCreate(e.altKey ? "file" : "folder")
          }
        }}
      >
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="h-(--tree-row-height) rounded-none px-(--tree-pad-x) text-[11px] font-normal tracking-[0.04em] uppercase">
            Files
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {treeError && (
              <p role="alert" className="text-destructive px-2 py-1 text-xs">
                {treeError}
              </p>
            )}

            <SidebarMenu>
              {/* At the root only when that is where the node is going --
                  inside a folder, the tree renders the row in place. */}
              {creating && createTarget === "" && <NameInput kind={creating} depth={0} />}
              {tree.map((node) => (
                <Tree key={node.name} node={node} path="" />
              ))}
            </SidebarMenu>

            {tree.length === 0 && !treeLoaded && !treeError && <TreeRowsSkeleton rows={8} dense />}
            {tree.length === 0 && treeLoaded && !treeLoading && !treeError && (
              // An empty workspace is a real answer, not a failure: a project
              // created before the clone reactor has nothing on disk yet.
              <p className="text-muted-foreground px-2 py-2 text-xs">
                This workspace is empty. Add a file with the buttons above, or ask the agent to
                create one.
              </p>
            )}
            {treeTruncated && (
              <p className="text-muted-foreground px-2 py-2 text-xs">
                Only the first few thousand files are listed.
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </div>
    </>
  )
}

/** The row you type a new name into, committed with Enter and dropped with Escape. */
function NameInput({ kind, depth }: { kind: "file" | "folder"; depth: number }) {
  const { commitCreate, cancelCreate } = useFilesPanel()

  return (
    <SidebarMenuItem style={depthStyle(depth)}>
      <div className="flex h-(--tree-row-height) items-center pr-(--tree-pad-x) pl-[calc(var(--tree-pad-x)+var(--tree-indent)*var(--ucch-tree-depth,0))]">
        <ChevronColumn />
        {/* The default of its kind: there is no name to pick a better one by yet. */}
        <FileTypeIcon
          name=""
          kind={kind}
          className="mr-(--tree-gap-label) size-(--tree-icon-size) shrink-0"
        />
        <input
          autoFocus
          placeholder={kind === "folder" ? "folder name" : "file name"}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-(length:--tree-font-size) outline-hidden"
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== "Escape") return
            // Without this the keypress carries on to whatever gains focus
            // next -- and for a new file that is the editor, which takes the
            // Enter as a newline and opens the file with a blank line in it.
            e.preventDefault()
            if (e.key === "Enter") commitCreate(e.currentTarget.value)
            else cancelCreate()
          }}
          // Clicking away is a cancel: an empty half-typed row left behind
          // would be a node that does not exist anywhere.
          onBlur={cancelCreate}
        />
      </div>
    </SidebarMenuItem>
  )
}

/**
 * One node of the tree, recursing into its children.
 *
 * `path` is the parent's path: a node needs its full path to open, and the
 * tree data is nested names rather than paths, so it is accumulated on the way
 * down instead of being repeated in the data.
 *
 * Files and folders are separate components rather than two branches of one,
 * because a folder holds open/closed state and a file does not -- and a hook
 * behind a conditional return is a hook that runs on some renders and not
 * others.
 */
/**
 * What a row does when picked up: it carries itself, or the whole selection
 * when it is part of one, so a set built with ctrl-clicks moves together.
 * `dragend` fires on the source however the drag finished, which makes it the
 * one place to clear the state whether the drop landed, missed, or was
 * cancelled with Escape.
 */
function dragHandlers(
  full: string,
  { selectedPaths, setDragging, setDropTarget }: FilesPanelContextValue,
): Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd"> {
  return {
    draggable: true,
    onDragStart: (e) => {
      const paths = selectedPaths.has(full) ? [...selectedPaths] : [full]
      e.dataTransfer.setData(DRAG_TYPE, paths.join("\n"))
      e.dataTransfer.effectAllowed = "move"
      setDragging(paths)
    },
    onDragEnd: () => {
      setDragging(null)
      setDropTarget(null)
    },
  }
}

/**
 * What a folder (or the root) does while a row is dragged over it.
 *
 * Only this app's rows are taken; files dragged in from the desktop pass
 * through untouched. The events stop here so the tree underneath a folder
 * does not also light up as the root. `onHover` runs on each move over a
 * folder that would accept the drop, and `onLeave` when it is left or
 * dropped on, so a row can open itself after a moment.
 */
function dropHandlers({
  folder,
  dragging,
  dropTarget,
  setDropTarget,
  move,
  onHover,
  onLeave,
}: Pick<FilesPanelContextValue, "dragging" | "dropTarget" | "setDropTarget" | "move"> & {
  folder: string
  onHover?: () => void
  onLeave?: () => void
}): Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop"> {
  return {
    onDragOver: (e) => {
      if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      const allowed = movableInto(dragging, folder).length > 0
      e.dataTransfer.dropEffect = allowed ? "move" : "none"
      if (!allowed) {
        if (dropTarget === folder) setDropTarget(null)
        return
      }
      if (dropTarget !== folder) setDropTarget(folder)
      onHover?.()
    },
    onDragLeave: (e) => {
      // Moving between the row's own children is not leaving it.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      onLeave?.()
      if (dropTarget === folder) setDropTarget(null)
    },
    onDrop: (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      onLeave?.()
      setDropTarget(null)
      const carried = e.dataTransfer.getData(DRAG_TYPE)
      const paths = carried ? carried.split("\n") : dragging
      if (paths && paths.length > 0) void move(paths, folder)
    },
  }
}

/**
 * The fixed column at the start of a row that a folder's chevron is centred
 * in. Files and the name input keep it empty, so every icon at one depth
 * lines up.
 */
function ChevronColumn({ children }: { children?: React.ReactNode }) {
  return (
    <span
      data-tree-chevron
      aria-hidden
      className="mr-(--tree-gap-chevron) flex size-(--tree-chevron-size) shrink-0 items-center justify-center"
    >
      {children}
    </span>
  )
}

/** How many folders deep a path sits: 0 for a top-level node. */
function treeDepth(full: string): number {
  return full.split("/").length - 1
}

/** The depth a tree row, and the guide under its children, indent by. */
function depthStyle(depth: number): React.CSSProperties {
  return { "--ucch-tree-depth": depth } as React.CSSProperties
}

function Tree({ node, path }: { node: FileNode; path: string }) {
  const full = path ? `${path}/${node.name}` : node.name
  return node.children ? (
    <FolderRow name={node.name} full={full} children_={node.children} />
  ) : (
    <FileRow name={node.name} full={full} />
  )
}

function FileRow({ name, full }: { name: string; full: string }) {
  const panel = useFilesPanel()
  const { openFile, selectRow, selectedPaths, dirty, loadingFiles, changed } = panel

  // Your own unsaved edit wins over the agent's: it is the later of the two,
  // and it is the one that is still only in this browser.
  const edited = dirty.has(full)
  const mark = edited ? "MM" : changed.has(full) ? "MA" : null

  return (
    <SidebarMenuItem style={depthStyle(treeDepth(full))}>
      {/* A plain click opens the file; with a modifier held it only changes
          the selection, so building a set to delete does not open each one. */}
      <SidebarMenuButton
        isActive={selectedPaths.has(full)}
        {...dragHandlers(full, panel)}
        onClick={(e) => {
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            selectRow(full, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
            return
          }
          openFile(full)
        }}
      >
        {/* No chevron, but its column: the icon lines up with its sibling
            folders' icons rather than with their chevrons. */}
        <ChevronColumn />
        {/* The Material icon for the type, which is also what says an image
            or a PDF will open into a preview rather than the editor. */}
        <FileTypeIcon name={name} />
        <span className="truncate">{name}</span>
        {loadingFiles.has(full) && <Loader2Icon className="ml-auto size-3 animate-spin" />}
        {mark && !loadingFiles.has(full) && (
          <span
            // In flow at the end of the row rather than absolutely placed,
            // so a long filename truncates before it instead of running
            // underneath it.
            className={cn(
              "ml-auto shrink-0 pr-4 font-mono text-[10px] font-medium",
              edited ? "text-ucch-active" : "text-warning",
            )}
          >
            {mark}
            <span className="sr-only">
              {edited ? " modified by you" : " modified by the agent"}
            </span>
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * Stops the collapsible from toggling on this click. Base UI runs the
 * element's own handler first and skips its own when asked to; the method is
 * added to the event at merge time, so it is not on React's type.
 */
function preventToggle(e: React.MouseEvent) {
  ;(e as React.MouseEvent & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
}

function FolderRow({
  name,
  full,
  children_,
}: {
  name: string
  full: string
  children_: readonly FileNode[]
}) {
  const panel = useFilesPanel()
  const { selectRow, selectedPaths, creating, createTarget, expanded, setExpanded, dropTarget } =
    panel
  const open = expanded.has(full)
  const setOpen = (next: boolean) => setExpanded(full, next)

  // Hovering a shut folder with a drag for a moment opens it, so a drop can
  // reach something inside without letting go first.
  const expandTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearExpand = React.useCallback(() => {
    if (expandTimer.current) clearTimeout(expandTimer.current)
    expandTimer.current = null
  }, [])
  React.useEffect(() => clearExpand, [clearExpand])

  // This folder is where the node being named will land.
  const isTarget = creating !== null && createTarget === full

  // Naming something inside a shut folder would put the input out of sight,
  // and so would the node it creates. Opening it here rather than forcing
  // `open` also means it stays open afterwards, showing what was made.
  React.useEffect(() => {
    if (isTarget) setExpanded(full, true)
  }, [isTarget, full, setExpanded])

  return (
    <SidebarMenuItem style={depthStyle(treeDepth(full))}>
      <Collapsible
        className="group/collapsible [&[data-open]>button>[data-tree-chevron]>svg]:rotate-90"
        open={open}
        onOpenChange={setOpen}
      >
        {/* Clicking a folder both toggles it and selects it -- the selection
            is what says where a new file or folder will be created, so it has
            to be settable without opening anything. With a modifier held it
            only joins the selection: toggling too would shift every row below
            it while a range is being picked. */}
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              isActive={selectedPaths.has(full)}
              className={cn(
                dropTarget === full && "ring-ucch-active bg-ucch-active-bg/60 ring-1 ring-inset",
              )}
              {...dragHandlers(full, panel)}
              {...dropHandlers({
                ...panel,
                folder: full,
                onHover: () => {
                  if (!open && !expandTimer.current) {
                    expandTimer.current = setTimeout(() => setExpanded(full, true), 600)
                  }
                },
                onLeave: clearExpand,
              })}
              onClick={(e) => {
                const modified = e.shiftKey || e.ctrlKey || e.metaKey
                if (modified) preventToggle(e)
                selectRow(full, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
              }}
            />
          }
        >
          <ChevronColumn>
            <ChevronRightIcon className="transition-transform" />
          </ChevronColumn>
          <FileTypeIcon name={name} kind={open ? "folder-open" : "folder"} />
          <span className="truncate">{name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {isTarget && creating && <NameInput kind={creating} depth={treeDepth(full) + 1} />}
            {children_.map((child) => (
              <Tree key={child.name} node={child} path={full} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}
