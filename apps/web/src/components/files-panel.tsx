"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
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
  basename,
  createEntry,
  deleteEntry,
  FileConflictError,
  fetchFileVersion,
  fetchTree,
  isFolder,
  moveEntry,
  saveFile,
  type FileNode,
} from "@/lib/files-api"
import { targetOf, type ProjectTarget } from "@/lib/project-target"
import { projectQueries, treeKey } from "@/lib/queries/project-data"
import { movableInto } from "@/lib/file-drop"
import { isPreviewable } from "@ucch/protocol/plain"
import type { Project } from "@/lib/session"
import { isOwnChange, useProjectEvents, useToast } from "@/lib/realtime"
import { codeReference, type CodeReference } from "@/lib/code-chat"


export type { FileNode as Node }

/** The transfer type a row drag carries, so a folder ignores anything else dropped on it. */
const DRAG_TYPE = "application/x-ucch-file"

/** What the project page is showing: the conversation, the files, or a shell. */
export type ViewMode = "chat" | "file" | "docs" | "terminal" | "git"

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
  /** A newer copy of the project already named (a rename, a preview port), changing nothing else. */
  updateCurrentProject: (project: Project) => void

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
   * Paths whose buffer differs from what is on disk. The text itself is in
   * `useFileBuffers`, so typing does not re-render everything that reads
   * this context -- this set only changes when a file becomes or stops
   * being modified.
   */
  dirty: ReadonlySet<string>
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
  /** False until this project's tree has answered once: an empty `tree` is then "not here yet". */
  treeLoaded: boolean
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

  /** Moves each path into `folder` ("" for the project root), keeping its name. */
  move: (paths: readonly string[], folder: string) => Promise<void>
  /**
   * The folder a drag is hovering, so it can light up: "" is the root, null
   * means nothing is being dragged over the tree.
   */
  dropTarget: string | null
  setDropTarget: (folder: string | null) => void
  /**
   * The paths a drag is carrying, or null when nothing is being dragged. Kept
   * here rather than read off the transfer: the browser hides the transfer's
   * data from everything but the drop itself.
   */
  dragging: readonly string[] | null
  setDragging: (paths: readonly string[] | null) => void
}

const FilesPanelContext = React.createContext<FilesPanelContextValue | null>(null)

/**
 * The edited text of every file opened so far, keyed by path. Buffers
 * outlive both their tab and the editor itself, so closing a tab or stepping
 * over to the chat does not throw away unsaved work.
 *
 * A context of its own because it changes on every keystroke: in the main
 * one, each key re-rendered the whole file tree.
 */
interface FileBuffersContextValue {
  buffers: Readonly<Record<string, string>>
  setBuffer: (path: string, text: string) => void
}

const FileBuffersContext = React.createContext<FileBuffersContextValue | null>(null)

export function useFileBuffers() {
  const context = React.useContext(FileBuffersContext)
  if (!context) throw new Error("useFileBuffers must be used within a FilesPanelProvider.")
  return context
}

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
  // Read by the context's functions, which must not depend on `buffers`
  // itself or the whole value would change on every keystroke.
  const buffersRef = React.useRef(buffers)
  buffersRef.current = buffers
  const dirty = useStableSet(
    React.useMemo(
      () => Object.keys(buffers).filter((path) => buffers[path] !== saved[path]),
      [buffers, saved],
    ),
  )
  /**
   * The version of each open file as it was read, so a save goes over that
   * version or not at all -- never over a change made elsewhere since.
   */
  const versions = React.useRef<Record<string, string | null>>({})
  const toast = useToast()
  const [loadingFiles, setLoadingFiles] = React.useState<ReadonlySet<string>>(new Set())
  const [savingFiles, setSavingFiles] = React.useState<ReadonlySet<string>>(new Set())
  const [fileErrors, setFileErrors] = React.useState<Record<string, string>>({})
  const [selected, setSelected] = React.useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = React.useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpandedSet] = React.useState<ReadonlySet<string>>(new Set())
  const [tree, setTree] = React.useState<readonly FileNode[]>([])
  const [treeLoading, setTreeLoading] = React.useState(false)
  // The project whose tree has answered at least once. Until it matches, an
  // empty `tree` means "not here yet" and the panel draws skeleton rows.
  const [treeLoadedFor, setTreeLoadedFor] = React.useState<ProjectTarget | null>(null)
  const [treeError, setTreeError] = React.useState<string | null>(null)
  const [treeTruncated, setTreeTruncated] = React.useState(false)
  const [changed, setChanged] = React.useState<ReadonlySet<string>>(new Set())
  const [creating, setCreating] = React.useState<"file" | "folder" | null>(null)
  const [deleting, setDeleting] = React.useState<readonly string[] | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState<readonly string[] | null>(null)
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

  // The tree the panel shows: a project session's own worktree when the
  // page is one's, else the project's checkout. Memoised so it is a stable
  // identity for the effects and the "loaded for" check below.
  const queryClient = useQueryClient()
  const projectHash = project?.hash ?? null
  const sessionHash = project?.sessionHash ?? null
  const target = React.useMemo<ProjectTarget | null>(
    () => (projectHash ? targetOf({ hash: projectHash, sessionHash }) : null),
    [projectHash, sessionHash],
  )

  /**
   * Rereads the tree.
   *
   * A ref holds the last request's project so a reply for the project you
   * just navigated away from cannot overwrite the one you are looking at.
   */
  const treeRequest = React.useRef(0)
  const treeLoadFailed = React.useRef(false)
  const refreshTree = React.useCallback(() => {
    if (!target) return
    const ticket = ++treeRequest.current
    setTreeLoading(true)
    // Through the client cache, which keeps (and persists) the last tree of
    // every project, so opening one again starts from it -- see below.
    const { queryKey, queryFn } = projectQueries.filesTree(target)
    void queryClient
      .fetchQuery({
        queryKey,
        queryFn,
        staleTime: 0,
        meta: { persist: true },
      })
      .then((result) => {
        if (ticket !== treeRequest.current) return
        setTree(result.tree)
        setTreeTruncated(result.truncated)
        // A load that works clears the last load that did not -- and only
        // that. A move or delete that failed reports here too, and it
        // refreshes the tree right after, so clearing every time would
        // wipe its message before anyone read it.
        if (treeLoadFailed.current) {
          treeLoadFailed.current = false
          setTreeError(null)
        }
      })
      .catch((error: unknown) => {
        if (ticket !== treeRequest.current) return
        setTree([])
        treeLoadFailed.current = true
        setTreeError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (ticket !== treeRequest.current) return
        setTreeLoading(false)
        setTreeLoadedFor(target)
      })
  }, [target, queryClient])

  // The tree belongs to the project, so it is refetched when that changes --
  // including on first sight of one. A tree seen before is shown at once
  // while the fresh one loads, rather than a skeleton.
  React.useEffect(() => {
    setTreeError(null)
    treeLoadFailed.current = false
    if (!target) {
      setTree([])
      return
    }
    const cached = queryClient.getQueryData<Awaited<ReturnType<typeof fetchTree>>>(treeKey(target))
    if (cached) {
      setTree(cached.tree)
      setTreeTruncated(cached.truncated)
      setTreeLoadedFor(target)
    }
    refreshTree()
  }, [target, refreshTree, queryClient])

  const readFile = React.useCallback(
    (path: string) => {
      if (!target) return
      setLoadingFiles((current) => new Set(current).add(path))
      void fetchFileVersion(target, path)
        .then(({ content, version }) => {
          versions.current[path] = version
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
    [target],
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
      const current = buffersRef.current
      const isDirty = current[path] !== undefined && current[path] !== saved[path]
      if (!isDirty) readFile(path)
    }

    // Shuts the tree or the search, whichever is up; the chat column is not
    // theirs to close.
    function closeFileSidebar() {
      setSidebar((current) => (current === "files" || current === "search" ? null : current))
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
        // The tree and the search belong to the project they were opened
        // for; a page showing another one folds them away rather than
        // leaving one project's files beside another's conversation.
        if (project?.id !== next.id) closeFileSidebar()
        show(next)
        // Every view of a project starts as the conversation; a file view
        // left over from the last project would open on nothing.
        setMode("chat")
      },
      updateCurrentProject: (next) =>
        setProject((current) =>
          current?.id === next.id && current.sessionHash === next.sessionHash ? next : current,
        ),

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

      dirty,
      saved,
      loadingFiles,
      fileErrors,
      saving: savingFiles,
      save: async (path) => {
        const text = buffersRef.current[path]
        if (!target || text === undefined) return
        setSavingFiles((current) => new Set(current).add(path))
        try {
          versions.current[path] = await saveFile(target, path, text, versions.current[path])
          // What is on disk is now what is in the buffer, so the tab stops
          // reading as modified.
          setSaved((current) => ({ ...current, [path]: text }))
          refreshTree()
        } catch (error) {
          if (error instanceof FileConflictError) {
            // Changed elsewhere since it was opened -- another window, or the
            // agent. What is on disk stands; the edit here is reverted to it
            // and the person is told, rather than one silently overwriting
            // the other.
            toast({
              tone: "error",
              title: `${path} was changed elsewhere`,
              description:
                error.content === null
                  ? "It was deleted in another window. Your edits were not saved."
                  : "Your unsaved edits were reverted to the version on disk.",
            })
            if (error.content !== null) {
              const content = error.content
              versions.current[path] = error.version
              setBuffers((current) => ({ ...current, [path]: content }))
              setSaved((current) => ({ ...current, [path]: content }))
            } else {
              setFileErrors((current) => ({ ...current, [path]: error.message }))
            }
            return
          }
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
      treeLoaded: treeLoadedFor === target,
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
        const current = buffersRef.current
        const open = current[path] !== undefined
        const isDirty = open && current[path] !== saved[path]
        if (change !== "deleted" && open && !isDirty) readFile(path)
      },

      creating,
      createTarget,
      beginCreate: setCreating,
      cancelCreate: () => setCreating(null),
      commitCreate: (name) => {
        const trimmed = name.trim()
        setCreating(null)
        if (!trimmed || !creating || !target) return

        const path = createTarget ? `${createTarget}/${trimmed}` : trimmed
        setTreeError(null)
        void createEntry(target, path, creating === "folder" ? "directory" : "file")
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
        if (!target) return
        // The message is about the latest thing you did.
        setTreeError(null)
        // A path inside a selected folder goes with the folder; deleting it
        // separately would only fail once the folder is gone.
        const roots = paths.filter(
          (p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)),
        )
        const gone: string[] = []
        const failures: string[] = []
        for (const path of roots) {
          try {
            await deleteEntry(target, path)
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

      move: async (paths, folder) => {
        if (!target) return
        setTreeError(null)
        const moves = movableInto(paths, folder).map(
          (p) => [p, folder ? `${folder}/${basename(p)}` : basename(p)] as const,
        )
        if (moves.length === 0) return

        const done: (readonly [string, string])[] = []
        const failures: string[] = []
        for (const [from, to] of moves) {
          try {
            await moveEntry(target, from, to)
            done.push([from, to])
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        if (failures.length > 0) setTreeError(failures.join(" "))
        // Everything that knew a moved path by name learns its new one, so an
        // open tab keeps its buffer and a folder stays open where it landed.
        const renamed = (p: string) => {
          for (const [from, to] of done) {
            if (p === from) return to
            if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
          }
          return p
        }
        const rekey = (record: Record<string, string>) =>
          Object.fromEntries(Object.entries(record).map(([p, v]) => [renamed(p), v]))
        setTabs((current) => current.map(renamed))
        setActiveTab((current) => (current ? renamed(current) : current))
        setBuffers(rekey)
        setSaved(rekey)
        setSelected((current) => (current ? renamed(current) : current))
        setSelectedPaths((current) => new Set([...current].map(renamed)))
        setExpandedSet((current) => {
          const next = new Set([...current].map(renamed))
          if (folder) next.add(folder)
          return next
        })
        refreshTree()
      },
      dropTarget,
      setDropTarget,
      dragging,
      setDragging,
    }
  }, [
    project,
    sidebar,
    reveal,
    mode,
    tabs,
    activeTab,
    dirty,
    saved,
    loadingFiles,
    savingFiles,
    fileErrors,
    selected,
    selectedPaths,
    expanded,
    tree,
    treeLoading,
    treeLoadedFor,
    treeError,
    treeTruncated,
    changed,
    creating,
    createTarget,
    dropTarget,
    dragging,
    terminals,
    chatDock,
    codeChat,
    target,
    readFile,
    refreshTree,
    toast,
  ])

  // Files changed from another window: the same path as the agent's writes,
  // so an open, unedited file is reread under the editor. This window's own
  // saves are already on screen.
  const noteChangedRef = React.useRef(value.noteChanged)
  noteChangedRef.current = value.noteChanged
  // Changes made outside the server -- a terminal, git, a dev server -- are
  // reported only while the tree or a file is showing. Shown again, the
  // tree is reread for whatever changed meanwhile.
  const showsFiles = project !== null && (sidebar === "files" || tabs.length > 0)
  // Every tree of the project shares its topic: a change in another session's
  // worktree, or in the checkout while a session is shown, is not this one.
  const refreshTreeRef = React.useRef(refreshTree)
  refreshTreeRef.current = refreshTree
  useProjectEvents(
    project?.id,
    (event) => {
      // Too many to name -- an install, a build: read the tree again.
      if (event.type === "resource.changed" && event.resource === "files") {
        if ((event.id ?? null) === sessionHash) refreshTreeRef.current()
        return
      }
      // Any writer but this tab: another person, the agent, a git checkout.
      if (event.type !== "file.changed" || isOwnChange(event.origin)) return
      if ((event.worktreeId ?? null) !== sessionHash) return
      noteChangedRef.current(event.path, event.change)
    },
    { files: showsFiles, tree: sessionHash },
  )
  const showedFiles = React.useRef(showsFiles)
  React.useEffect(() => {
    if (showsFiles && !showedFiles.current) refreshTree()
    showedFiles.current = showsFiles
  }, [showsFiles, refreshTree])

  const buffersValue = React.useMemo<FileBuffersContextValue>(
    () => ({
      buffers,
      setBuffer: (path, text) => setBuffers((current) => ({ ...current, [path]: text })),
    }),
    [buffers],
  )

  return (
    <FilesPanelContext.Provider value={value}>
    <FileBuffersContext.Provider value={buffersValue}>
      {children}
      <DeleteEntryDialog
        paths={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={async (paths) => {
          setDeleting(null)
          await value.remove(paths)
        }}
      />
    </FileBuffersContext.Provider>
    </FilesPanelContext.Provider>
  )
}

/**
 * Tells the shell which project the page is showing, so the header's view
 * toggle and the tree act on it. An effect rather than a render-time call:
 * it writes state a parent owns.
 */
export function useCurrentProject(project: Project) {
  const { setCurrentProject, updateCurrentProject, closeFiles, closeSearch } = useFilesPanel()
  // The same project, read again: the header's menus name it as it is now.
  React.useEffect(() => updateCurrentProject(project), [project, updateCurrentProject])
  React.useEffect(() => {
    setCurrentProject(project)
    // Leaving the project's page -- for another project, its notes, the
    // dashboard -- folds the tree away: it was opened for this page, and a
    // column of files beside a page that cannot open them is only lost width.
    // "Open Files" from the project list is untouched, since it never
    // mounts this page.
    return () => {
      closeFiles()
      closeSearch()
    }
    // Identity is the project and the session's tree, not the object: the
    // page re-renders with a new object on every navigation within the same
    // project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.sessionHash])
}

/**
 * The file tree: the sidebar's contents, not the sidebar itself.
 *
 * The column it sits in -- and the animation that brings it in -- belong to
 * `RightSidebar`, which it shares with the search panel. This is only the tree,
 * its toolbar, and the header naming the project.
 */
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

/**
 * The same Set for as long as its members stay the same, so a memo or
 * context keyed on it does not change when nothing in it did.
 */
function useStableSet(items: readonly string[]): ReadonlySet<string> {
  const ref = React.useRef<ReadonlySet<string>>(new Set())
  const current = ref.current
  if (items.length !== current.size || items.some((item) => !current.has(item))) {
    ref.current = new Set(items)
  }
  return ref.current
}
