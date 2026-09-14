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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  createEntry,
  deleteEntry,
  fetchFile,
  fetchTree,
  isFolder,
  saveFile,
  type FileNode,
} from "@/lib/files-api"
import { isPreviewable } from "@ucch/protocol"
import type { Project } from "@/lib/session"
import { codeReference, type CodeReference } from "@/lib/code-chat"

export type { FileNode as Node }

/** What the project page is showing: the conversation, the files, or a shell. */
export type ViewMode = "chat" | "file" | "terminal" | "git"

/** Which panel the right-hand column is showing, or none. */
export type Sidebar = "files" | "search" | "chat"

interface FilesPanelContextValue {
  project: Project | null

  /**
   * The right-hand column: one slot, two possible contents.
   *
   * One rather than two columns because two eighteen-rem panels either side of
   * a conversation leave it unreadable on anything but a very wide screen --
   * and because the tree and the search results answer the same question from
   * different ends, so wanting both at once is rare.
   */
  sidebar: Sidebar | null
  filesOpen: boolean
  searchOpen: boolean
  openFiles: (project: Project) => void
  closeFiles: () => void
  openSearch: () => void
  closeSearch: () => void
  /**
   * The conversation, docked beside the editor.
   *
   * The same chat as the chat view -- one socket, one thread, one draft --
   * shown in the column instead of the page, so a prompt can run while you
   * keep editing. Opened by `:chat` from the editor, or by hand.
   */
  openChatSidebar: () => void
  closeChatSidebar: () => void
  /** Names the project a page is showing, without opening the tree for it. */
  setCurrentProject: (project: Project) => void

  mode: ViewMode
  setMode: (mode: ViewMode) => void

  tabs: readonly string[]
  activeTab: string | null
  openFile: (path: string) => void
  selectTab: (path: string) => void
  closeTab: (path: string) => void
  /** Drops every tab. Buffers stay, so unsaved work survives the sweep. */
  closeAllTabs: () => void

  /**
   * What the terminal view has open, reported by the view itself.
   *
   * The shells are the terminal's own state -- each is a socket subscription
   * it holds -- so rather than lift them here, the view tells the shell how
   * many there are and how to close them, and the header can act on that
   * without knowing anything about ptys.
   */
  terminals: { count: number; closeAll: () => void }
  registerTerminals: (terminals: { count: number; closeAll: () => void }) => void

  /**
   * The element the chat renders into, wherever on the page it is shown.
   *
   * Created once in the browser and owned here, above both the workspace and
   * the right-hand column, so either can host it. See `chat-dock.tsx`.
   */
  chatDock: HTMLDivElement | null

  /**
   * The lines `:chat` was last typed over, for the composer to attach.
   *
   * `initial` is anything typed after the command on the ex line
   * (`:chat rename this`). The token tells a second `:chat` over the same
   * lines apart from the first, so it refocuses the composer again.
   */
  codeChat: (CodeReference & { initial: string; token: number }) | null
  openCodeChat: (path: string, from: number, to: number, initial?: string) => void

  /**
   * Opens a file and puts the cursor on a line, for a search result.
   *
   * The token is what makes a second click on the same file work: the editor is
   * keyed on the path and does not remount, so "go here" has to be an event it
   * can tell apart from the last one rather than a value that has not changed.
   */
  reveal: { path: string; line: number; token: number } | null
  revealInFile: (path: string, line: number) => void

  /**
   * The edited text of every file opened so far, keyed by path. Buffers
   * outlive both their tab and the editor itself, so closing a tab or
   * stepping over to the chat does not throw away unsaved work.
   */
  buffers: Readonly<Record<string, string>>
  setBuffer: (path: string, text: string) => void
  /** What is on disk, as of the last read or save. Dirty is the difference. */
  saved: Readonly<Record<string, string>>
  /** Files being read from the server right now. */
  loadingFiles: ReadonlySet<string>
  /** Whatever went wrong for a file: too large, not text, gone. */
  fileErrors: Readonly<Record<string, string>>
  save: (path: string) => Promise<void>
  saving: ReadonlySet<string>

  /**
   * The row the tree is pointing at, file or folder. Separate from the active
   * tab: a folder can be selected without anything being open, and it is what
   * a new file or folder gets created inside. It is also the anchor a
   * shift-click extends from.
   */
  selected: string | null
  select: (path: string) => void
  /**
   * Every highlighted row. Usually just `selected`; a ctrl-click adds one row
   * and a shift-click adds the run of visible rows between the anchor and the
   * click, the way a file manager does.
   */
  selectedPaths: ReadonlySet<string>
  /** A click on a row, with the modifiers that say how it joins the selection. */
  selectRow: (path: string, modifiers: { shift: boolean; ctrl: boolean }) => void
  /** Folders that are open. Held here so a shift range can walk the visible rows. */
  expanded: ReadonlySet<string>
  setExpanded: (path: string, open: boolean) => void

  tree: readonly FileNode[]
  treeLoading: boolean
  treeError: string | null
  treeTruncated: boolean
  refreshTree: () => void
  /** Paths written since this project was opened, from `file.changed`. */
  changed: ReadonlySet<string>
  noteChanged: (path: string, change: "added" | "modified" | "deleted") => void

  /**
   * The kind of node being named right now, or null when nothing is being
   * created. Held here rather than in the panel because the naming row is
   * rendered by the tree, nested inside the folder it will land in.
   */
  creating: "file" | "folder" | null
  /** The folder a new node goes in: "" for the project root. */
  createTarget: string
  beginCreate: (kind: "file" | "folder") => void
  cancelCreate: () => void
  commitCreate: (name: string) => void

  /** The paths awaiting a delete confirmation, and the act itself. */
  askDelete: (paths: readonly string[]) => void
  remove: (paths: readonly string[]) => Promise<void>
}

const FilesPanelContext = React.createContext<FilesPanelContextValue | null>(null)

export function useFilesPanel() {
  const context = React.useContext(FilesPanelContext)
  if (!context) throw new Error("useFilesPanel must be used within a FilesPanelProvider.")
  return context
}

/**
 * Holds which project's files are open, which of the two views the project is
 * in, and which files the editor has in tabs.
 *
 * All three are read and written from places that cannot see each other -- the
 * tree lives beside the page, the mode toggle lives in the header, and the
 * editor lives inside the page -- so the state sits above all of them, in the
 * shell. One project at a time: opening a second replaces the first rather
 * than stacking panels nothing would close.
 *
 * The tree and every buffer come from the server, which reads and writes the
 * project's real workspace directory. Nothing here is invented: an empty tree
 * means an empty workspace.
 */
export function FilesPanelProvider({ children }: { children: React.ReactNode }) {
  const [project, setProject] = React.useState<Project | null>(null)
  const [sidebar, setSidebar] = React.useState<Sidebar | null>(null)
  const [reveal, setReveal] = React.useState<FilesPanelContextValue["reveal"]>(null)
  const [mode, setMode] = React.useState<ViewMode>("chat")
  const [tabs, setTabs] = React.useState<readonly string[]>([])
  const [activeTab, setActiveTab] = React.useState<string | null>(null)
  const [buffers, setBuffers] = React.useState<Record<string, string>>({})
  const [saved, setSaved] = React.useState<Record<string, string>>({})
  const [loadingFiles, setLoadingFiles] = React.useState<ReadonlySet<string>>(new Set())
  const [savingFiles, setSavingFiles] = React.useState<ReadonlySet<string>>(new Set())
  const [fileErrors, setFileErrors] = React.useState<Record<string, string>>({})
  const [selected, setSelected] = React.useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = React.useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpandedSet] = React.useState<ReadonlySet<string>>(new Set())
  const [tree, setTree] = React.useState<readonly FileNode[]>([])
  const [treeLoading, setTreeLoading] = React.useState(false)
  const [treeError, setTreeError] = React.useState<string | null>(null)
  const [treeTruncated, setTreeTruncated] = React.useState(false)
  const [changed, setChanged] = React.useState<ReadonlySet<string>>(new Set())
  const [creating, setCreating] = React.useState<"file" | "folder" | null>(null)
  const [deleting, setDeleting] = React.useState<readonly string[] | null>(null)
  const [terminals, setTerminals] = React.useState<FilesPanelContextValue["terminals"]>({
    count: 0,
    closeAll: () => {},
  })
  const [codeChat, setCodeChat] = React.useState<FilesPanelContextValue["codeChat"]>(null)
  // In an effect rather than a state initialiser: there is no `document` on
  // the server, and the first client render has to match what it produced.
  const [chatDock, setChatDock] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const element = document.createElement("div")
    element.className = "flex min-h-0 flex-1 flex-col"
    setChatDock(element)
  }, [])

  // New nodes land inside the selected folder, or beside the selected file --
  // the same place a file manager would put them. Nothing selected is the
  // project root.
  const createTarget = folderOf(tree, selected)

  const hash = project?.hash ?? null

  /**
   * Rereads the tree.
   *
   * A ref holds the last request's project so a reply for the project you
   * just navigated away from cannot overwrite the one you are looking at.
   */
  const treeRequest = React.useRef(0)
  const refreshTree = React.useCallback(() => {
    if (!hash) return
    const ticket = ++treeRequest.current
    setTreeLoading(true)
    void fetchTree(hash)
      .then((result) => {
        if (ticket !== treeRequest.current) return
        setTree(result.tree)
        setTreeTruncated(result.truncated)
        setTreeError(null)
      })
      .catch((error: unknown) => {
        if (ticket !== treeRequest.current) return
        setTree([])
        setTreeError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (ticket === treeRequest.current) setTreeLoading(false)
      })
  }, [hash])

  // The tree belongs to the project, so it is refetched when that changes --
  // including on first sight of one.
  React.useEffect(() => {
    if (!hash) {
      setTree([])
      return
    }
    refreshTree()
  }, [hash, refreshTree])

  const readFile = React.useCallback(
    (path: string) => {
      if (!hash) return
      setLoadingFiles((current) => new Set(current).add(path))
      void fetchFile(hash, path)
        .then((content) => {
          setBuffers((current) => ({ ...current, [path]: content }))
          setSaved((current) => ({ ...current, [path]: content }))
          setFileErrors((current) => {
            const { [path]: _gone, ...rest } = current
            return rest
          })
        })
        .catch((error: unknown) => {
          setFileErrors((current) => ({
            ...current,
            [path]: error instanceof Error ? error.message : String(error),
          }))
        })
        .finally(() => {
          setLoadingFiles((current) => {
            const next = new Set(current)
            next.delete(path)
            return next
          })
        })
    },
    [hash],
  )

  const value = React.useMemo<FilesPanelContextValue>(() => {
    function show(next: Project) {
      // Tabs and buffers belong to a project, so they do not survive a move
      // to another one -- carrying them over would show one project's paths
      // above another's contents.
      if (project?.id !== next.id) {
        setTabs([])
        setActiveTab(null)
        setBuffers({})
        setSaved({})
        setFileErrors({})
        setSelected(null)
        setSelectedPaths(new Set())
        setExpandedSet(new Set())
        setTree([])
        setChanged(new Set())
        setCreating(null)
      }
      setProject(next)
    }

    function openFile(path: string) {
      setTabs((current) => (current.includes(path) ? current : [...current, path]))
      setActiveTab(path)
      setSelected(path)
      setSelectedPaths(new Set([path]))
      setMode("file")

      // An image or a PDF has no text to read and no buffer to hold: the
      // preview loads the bytes itself from `/file/raw`. Reading it here
      // would fetch a megabyte of JPEG only for the server to refuse it as
      // "not text", and leave that refusal on screen as an error.
      if (isPreviewable(path)) return

      // Always reread: the agent may have rewritten the file since it was
      // last opened, and the version on disk is the one being edited.
      // A buffer with unsaved edits is left alone.
      setBuffers((current) => {
        const dirty = current[path] !== undefined && current[path] !== saved[path]
        if (!dirty) readFile(path)
        return current
      })
    }

    return {
      project,
      sidebar,
      filesOpen: sidebar === "files",
      searchOpen: sidebar === "search",
      openFiles: (next) => {
        show(next)
        setSidebar("files")
      },
      closeFiles: () => setSidebar((current) => (current === "files" ? null : current)),
      openSearch: () => setSidebar("search"),
      closeSearch: () => setSidebar((current) => (current === "search" ? null : current)),
      setCurrentProject: (next) => {
        show(next)
        // Every view of a project starts as the conversation; a file view
        // left over from the last project would open on nothing.
        setMode("chat")
      },

      mode,
      setMode: (next) => {
        setMode(next)
        // The tree belongs to the file view. Switching to files with nothing
        // in the sidebar would be a dead end -- there would be no way to
        // choose what to read -- so it opens; search counts as something, it
        // opens files too, so it is not replaced. Leaving for the chat or a
        // shell folds the tree away again, giving the width back; it can
        // still be reopened by hand from the header. Search stays: it was
        // asked for, not opened by default.
        if (next === "file") setSidebar((current) => current ?? "files")
        else setSidebar((current) => (current === "files" ? null : current))
        // The chat cannot be in the column and on the page at once: the page
        // wins, and the column gives its width back.
        if (next === "chat") setSidebar((current) => (current === "chat" ? null : current))
      },

      tabs,
      activeTab,
      openFile,
      reveal,
      revealInFile: (path, line) => {
        openFile(path)
        // A token rather than a flag: clicking two results in one file has to
        // move the cursor twice, and nothing else about the request changed.
        setReveal((current) => ({ path, line, token: (current?.token ?? 0) + 1 }))
      },
      selectTab: (path) => {
        setActiveTab(path)
        // The tree follows the editor, so the highlighted row is always the
        // file you are looking at.
        setSelected(path)
        setSelectedPaths(new Set([path]))
      },
      closeTab: (path) => {
        const remaining = tabs.filter((p) => p !== path)
        setTabs(remaining)
        if (activeTab !== path) return
        // Falls back to the neighbour on the left, the way an editor does,
        // rather than to nothing.
        const i = tabs.indexOf(path)
        setActiveTab(remaining[i - 1] ?? remaining[0] ?? null)
      },
      closeAllTabs: () => {
        setTabs([])
        setActiveTab(null)
      },
      terminals,
      registerTerminals: setTerminals,
      chatDock,
      codeChat,
      openCodeChat: (path, from, to, initial = "") => {
        setCodeChat((current) => ({
          ...codeReference(path, from, to),
          initial,
          token: (current?.token ?? 0) + 1,
        }))
        // The question is typed in the chat, so bring it alongside.
        if (mode !== "chat") setSidebar("chat")
      },
      openChatSidebar: () => setSidebar("chat"),
      closeChatSidebar: () => setSidebar((current) => (current === "chat" ? null : current)),

      buffers,
      setBuffer: (path, text) => setBuffers((current) => ({ ...current, [path]: text })),
      saved,
      loadingFiles,
      fileErrors,
      saving: savingFiles,
      save: async (path) => {
        const text = buffers[path]
        if (!hash || text === undefined) return
        setSavingFiles((current) => new Set(current).add(path))
        try {
          await saveFile(hash, path, text)
          // What is on disk is now what is in the buffer, so the tab stops
          // reading as modified.
          setSaved((current) => ({ ...current, [path]: text }))
          refreshTree()
        } catch (error) {
          setFileErrors((current) => ({
            ...current,
            [path]: error instanceof Error ? error.message : String(error),
          }))
        } finally {
          setSavingFiles((current) => {
            const next = new Set(current)
            next.delete(path)
            return next
          })
        }
      },

      selected,
      select: (path) => {
        setSelected(path)
        setSelectedPaths(new Set([path]))
      },
      selectedPaths,
      selectRow: (path, { shift, ctrl }) => {
        if (shift && selected) {
          // The range runs over what is on screen, so a shut folder counts as
          // one row and its contents are not swept up unseen.
          const rows = visibleRows(tree, expanded)
          const from = rows.indexOf(selected)
          const to = rows.indexOf(path)
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from]
            setSelectedPaths(new Set(rows.slice(lo, hi + 1)))
            // The anchor stays put, so a second shift-click resizes the range
            // rather than starting a new one.
            return
          }
        }
        if (ctrl) {
          setSelectedPaths((current) => {
            const next = new Set(current)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
          })
          setSelected(path)
          return
        }
        setSelected(path)
        setSelectedPaths(new Set([path]))
      },
      expanded,
      setExpanded: (path, open) =>
        setExpandedSet((current) => {
          if (current.has(path) === open) return current
          const next = new Set(current)
          if (open) next.add(path)
          else next.delete(path)
          return next
        }),

      tree,
      treeLoading,
      treeError,
      treeTruncated,
      refreshTree,
      changed,
      noteChanged: (path, change) => {
        setChanged((current) => new Set(current).add(path))
        refreshTree()
        // An open file the agent rewrote is reread, so the editor is not
        // showing a version that no longer exists on disk. An unsaved edit of
        // your own wins: it is yours, and it is not on disk anywhere else.
        // Read from the closure rather than inside a state updater: an
        // updater is meant to be pure, and React runs it twice in
        // development, which fetched the file twice per change.
        const open = buffers[path] !== undefined
        const dirty = open && buffers[path] !== saved[path]
        if (change !== "deleted" && open && !dirty) readFile(path)
      },

      creating,
      createTarget,
      beginCreate: setCreating,
      cancelCreate: () => setCreating(null),
      commitCreate: (name) => {
        const trimmed = name.trim()
        setCreating(null)
        if (!trimmed || !creating || !hash) return

        const path = createTarget ? `${createTarget}/${trimmed}` : trimmed
        void createEntry(hash, path, creating === "folder" ? "directory" : "file")
          .then(() => {
            refreshTree()
            setSelected(path)
            setSelectedPaths(new Set([path]))
            // A file you just made opens straight away, on the assumption you
            // made it to write in it.
            if (creating === "file") openFile(path)
          })
          .catch((error: unknown) => {
            setTreeError(error instanceof Error ? error.message : String(error))
          })
      },

      askDelete: setDeleting,
      remove: async (paths) => {
        if (!hash) return
        // A path inside a selected folder goes with the folder; deleting it
        // separately would only fail once the folder is gone.
        const roots = paths.filter(
          (p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)),
        )
        const gone: string[] = []
        const failures: string[] = []
        for (const path of roots) {
          try {
            await deleteEntry(hash, path)
            gone.push(path)
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        if (failures.length > 0) setTreeError(failures.join(" "))
        // Everything the deleted paths were: their tabs, their buffers, their
        // place in the tree. A folder takes its children with it.
        const inside = (p: string) => gone.some((path) => p === path || p.startsWith(`${path}/`))
        setTabs((current) => current.filter((p) => !inside(p)))
        setActiveTab((current) => (current && inside(current) ? null : current))
        setBuffers((current) => Object.fromEntries(Object.entries(current).filter(([p]) => !inside(p))))
        setSaved((current) => Object.fromEntries(Object.entries(current).filter(([p]) => !inside(p))))
        setSelected((current) => (current && inside(current) ? null : current))
        setSelectedPaths((current) => new Set([...current].filter((p) => !inside(p))))
        setExpandedSet((current) => new Set([...current].filter((p) => !inside(p))))
        refreshTree()
      },
    }
  }, [
    project,
    sidebar,
    reveal,
    mode,
    tabs,
    activeTab,
    buffers,
    saved,
    loadingFiles,
    savingFiles,
    fileErrors,
    selected,
    selectedPaths,
    expanded,
    tree,
    treeLoading,
    treeError,
    treeTruncated,
    changed,
    creating,
    createTarget,
    terminals,
    chatDock,
    codeChat,
    hash,
    readFile,
    refreshTree,
  ])

  return (
    <FilesPanelContext.Provider value={value}>
      {children}
      <DeleteEntryDialog
        paths={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={async (paths) => {
          setDeleting(null)
          await value.remove(paths)
        }}
      />
    </FilesPanelContext.Provider>
  )
}

/**
 * Tells the shell which project the page is showing, so the header's view
 * toggle and the tree act on it. An effect rather than a render-time call:
 * it writes state a parent owns.
 */
export function useCurrentProject(project: Project) {
  const { setCurrentProject } = useFilesPanel()
  React.useEffect(() => {
    setCurrentProject(project)
    // Identity is the project, not the object: the page re-renders with a new
    // object on every navigation within the same project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
}

/**
 * The file tree: the sidebar's contents, not the sidebar itself.
 *
 * The column it sits in -- and the animation that brings it in -- belong to
 * `RightSidebar`, which it shares with the search panel. This is only the tree,
 * its toolbar, and the header naming the project.
 */
export function FilesTree() {
  const {
    project,
    closeFiles,
    tree,
    treeLoading,
    treeError,
    treeTruncated,
    refreshTree,
    creating,
    createTarget,
    beginCreate,
    selectedPaths,
    askDelete,
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

      {/* Focusable so the Delete key has somewhere to land: a click on a row
          puts focus inside, and the key bubbles up here. Keeping the handler
          on the tree rather than the window means Delete in the editor stays
          an edit. */}
      <div
        className="min-h-0 flex-1 overflow-auto outline-hidden"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "Delete") return
          if (selectedPaths.size === 0) return
          if (e.target instanceof HTMLInputElement) return
          e.preventDefault()
          askDelete([...selectedPaths])
        }}
      >
        <SidebarGroup>
          <SidebarGroupLabel>Files</SidebarGroupLabel>
          <SidebarGroupContent>
            {treeError && (
              <p role="alert" className="text-destructive px-2 py-1 text-xs">
                {treeError}
              </p>
            )}

            <SidebarMenu>
              {/* At the root only when that is where the node is going --
                  inside a folder, the tree renders the row in place. */}
              {creating && createTarget === "" && <NameInput kind={creating} />}
              {tree.map((node) => (
                <Tree key={node.name} node={node} path="" />
              ))}
            </SidebarMenu>

            {tree.length === 0 && !treeLoading && !treeError && (
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

/**
 * The folder a new node belongs in: the selection itself when it is a folder,
 * otherwise the folder holding it.
 */
function folderOf(tree: readonly FileNode[], selected: string | null): string {
  if (!selected) return ""
  return isFolder(tree, selected)
    ? selected
    : selected.slice(0, Math.max(0, selected.lastIndexOf("/")))
}

/**
 * Every row on screen, top to bottom: the order a shift-click range runs in.
 * A shut folder contributes itself and nothing below it.
 */
function visibleRows(tree: readonly FileNode[], expanded: ReadonlySet<string>): string[] {
  const rows: string[] = []
  const walk = (nodes: readonly FileNode[], parent: string) => {
    for (const node of nodes) {
      const full = parent ? `${parent}/${node.name}` : node.name
      rows.push(full)
      if (node.children && expanded.has(full)) walk(node.children, full)
    }
  }
  walk(tree, "")
  return rows
}

/** The row you type a new name into, committed with Enter and dropped with Escape. */
function NameInput({ kind }: { kind: "file" | "folder" }) {
  const { commitCreate, cancelCreate } = useFilesPanel()

  return (
    <SidebarMenuItem>
      <div className="flex h-8 items-center gap-2 rounded-md px-2">
        {/* The default of its kind: there is no name to pick a better one by yet. */}
        <FileTypeIcon name="" kind={kind} />
        <input
          autoFocus
          placeholder={kind === "folder" ? "folder name" : "file name"}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-hidden"
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
function Tree({ node, path }: { node: FileNode; path: string }) {
  const full = path ? `${path}/${node.name}` : node.name
  return node.children ? (
    <FolderRow name={node.name} full={full} children_={node.children} />
  ) : (
    <FileRow name={node.name} full={full} />
  )
}

function FileRow({ name, full }: { name: string; full: string }) {
  const { openFile, selectRow, selectedPaths, buffers, saved, loadingFiles, changed } =
    useFilesPanel()

  // Your own unsaved edit wins over the agent's: it is the later of the two,
  // and it is the one that is still only in this browser.
  const edited = buffers[full] !== undefined && buffers[full] !== saved[full]
  const mark = edited ? "MM" : changed.has(full) ? "MA" : null

  return (
    <SidebarMenuItem>
      {/* A plain click opens the file; with a modifier held it only changes
          the selection, so building a set to delete does not open each one. */}
      <SidebarMenuButton
        isActive={selectedPaths.has(full)}
        onClick={(e) => {
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            selectRow(full, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
            return
          }
          openFile(full)
        }}
      >
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
              edited ? "text-ucch-active" : "text-amber-600 dark:text-amber-500",
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
  const { selectRow, selectedPaths, creating, createTarget, expanded, setExpanded } =
    useFilesPanel()
  const open = expanded.has(full)
  const setOpen = (next: boolean) => setExpanded(full, next)

  // This folder is where the node being named will land.
  const isTarget = creating !== null && createTarget === full

  // Naming something inside a shut folder would put the input out of sight,
  // and so would the node it creates. Opening it here rather than forcing
  // `open` also means it stays open afterwards, showing what was made.
  React.useEffect(() => {
    if (isTarget) setExpanded(full, true)
  }, [isTarget, full, setExpanded])

  return (
    <SidebarMenuItem>
      <Collapsible
        className="group/collapsible [&[data-open]>button>svg:first-child]:rotate-90"
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
              onClick={(e) => {
                const modified = e.shiftKey || e.ctrlKey || e.metaKey
                if (modified) preventToggle(e)
                selectRow(full, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
              }}
            />
          }
        >
          <ChevronRightIcon className="transition-transform" />
          <FileTypeIcon name={name} kind={open ? "folder-open" : "folder"} />
          <span className="truncate">{name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {isTarget && creating && <NameInput kind={creating} />}
            {children_.map((child) => (
              <Tree key={child.name} node={child} path={full} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  )
}

/**
 * Confirming a delete.
 *
 * A button rather than the project dialog's typed name: this removes one path
 * from a working tree that git can usually restore, where deleting a project
 * removes the repository and its whole history. A folder still says how much
 * it is taking with it.
 */
function DeleteEntryDialog({
  paths,
  onOpenChange,
  onConfirm,
}: {
  paths: readonly string[] | null
  onOpenChange: (open: boolean) => void
  onConfirm: (paths: readonly string[]) => Promise<void>
}) {
  const [pending, setPending] = React.useState(false)

  return (
    <Dialog open={paths !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {paths && paths.length === 1 ? `Delete ${paths[0]}?` : `Delete ${paths?.length ?? 0} items?`}
          </DialogTitle>
          <DialogDescription>
            {paths && paths.length === 1 ? "It is" : "They are"} removed from the project&apos;s
            workspace on disk. A folder takes everything inside it.
          </DialogDescription>
        </DialogHeader>
        {paths && paths.length > 1 && (
          <ul className="max-h-48 overflow-auto font-mono text-xs">
            {paths.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              if (!paths) return
              setPending(true)
              void onConfirm(paths).finally(() => setPending(false))
            }}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
