"use client"

import * as React from "react"
import dynamic from "next/dynamic"

import { ChatDock, ChatPortal } from "@/components/chat-dock"
import { CodeEditor } from "@/components/code-editor"
import { useCurrentProject, useFilesPanel, type ViewMode } from "@/components/files-panel"
import { NotesWorkspace, type DocLocation } from "@/components/notes/notes-workspace"
import { ProjectChat } from "@/components/project-chat"
import { SessionContextCard } from "@/components/session-context-card"
import { useProject } from "@/lib/queries/project"
import type { Project, ProjectSession } from "@/lib/session"

// Loaded on first use rather than with the page. The terminal brings xterm
// and its addons; git brings the diff view and with it most of CodeMirror's
// language packs. Neither is needed to read a conversation, which is what
// almost every visit to this page is for.
const TerminalView = dynamic(
  () => import("@/components/terminal-view").then((m) => m.TerminalView),
  { ssr: false },
)
const GitView = dynamic(() => import("@/components/git/git-view").then((m) => m.GitView), {
  ssr: false,
})

/**
 * A project's views: the conversation, the files, its documentation, a
 * shell, and git -- of one session of it, when `session` is given.
 *
 * All are reached from the same URL rather than from separate routes,
 * because the tree stays open across the switch -- the mode is which half of
 * the same project view you are looking at, not where you are.
 */
export function ProjectWorkspace({ project: seed, session }: { project: Project; session?: ProjectSession }) {
  // The live copy, so a rename or a new preview port shows without the page
  // being rendered again (`ProjectSeed` on the page fills it).
  const base = useProject(seed.hash) ?? seed
  // In a project session the files, the terminal and git work in the
  // session's own worktree; a session without a branch -- the project's
  // first, or one older than worktrees -- works in the main checkout. A
  // session a handoff started works in the old one's worktree, named by
  // that one's hash (`treeHash`), which is what its file events carry.
  const sessionHash = session?.branch ? (session.treeHash ?? session.hash) : null
  const project = React.useMemo(() => ({ ...base, sessionHash }), [base, sessionHash])
  useCurrentProject(project)
  const { mode, sidebar, setMode } = useFilesPanel()
  useViewInUrl(mode, setMode, `${project.id}:${sessionHash ?? ""}`)

  // ProjectChat holds its thread's subscription, so it stays mounted and
  // hidden rather than unmounting: switching to files and back would
  // otherwise end the subscription and replay the thread again. It is
  // rendered through a portal so the right-hand column can show the same
  // instance beside the editor; the dock here is where it sits otherwise.
  const docked = mode !== "chat" && sidebar === "chat"

  // Once opened, the terminal stays mounted (see below); until then it is
  // not mounted at all, so its chunk is not fetched for a visit that never
  // opens it. Set during render, React's pattern for state derived from a
  // prop, so the first frame in terminal mode already has it.
  const [terminalOpened, setTerminalOpened] = React.useState(mode === "terminal")
  if (mode === "terminal" && !terminalOpened) setTerminalOpened(true)

  // The page and view of the documentation open here. Held by the session
  // rather than the workspace, which unmounts behind the chat, so coming
  // back lands where you left it.
  const [doc, setDoc] = React.useState<DocLocation>({ noteId: null, view: "notes" })
  return (
    <>
      <ChatPortal>
        <ProjectChat project={project} session={session} />
      </ChatPortal>
      {!docked && (
        // Relative, for the details card that floats at its top right.
        <div className={mode === "chat" ? "@container/session relative flex min-h-0 flex-1 flex-col" : "hidden"}>
          <ChatDock className="flex min-h-0 flex-1 flex-col" />
          {mode === "chat" && <SessionContextCard project={project} session={session} />}
        </div>
      )}
      {mode === "file" && <CodeEditor />}

      {/* The project's notes, on the session's own URL: moving between
          pages changes `doc`, not the address. Mounted only while shown,
          like the editor; the note editor inside it is code-split. */}
      {mode === "docs" && <NotesWorkspace project={base} location={doc} onLocationChange={setDoc} />}

      {/* Mounted alongside the chat rather than swapped in: a shell keeps
          running while you read the files, and its scrollback is still there
          when you come back. Nothing is loaded until the view is first
          opened. */}
      {terminalOpened && (
        <div className={mode === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <TerminalView project={project} active={mode === "terminal"} />
        </div>
      )}

      {/* Mounted only while shown, like the editor: its socket and poll have
          no reason to run behind the chat. */}
      {mode === "git" && <GitView project={project} session={session ?? null} />}
    </>
  )
}

/** The views worth a link: a file view needs a file open, so it is not one. */
const LINKED_VIEWS: ReadonlySet<ViewMode> = new Set(["docs", "terminal", "git"])

/**
 * Keeps the view in the URL's `?view=` so a reload or a shared link opens
 * on it. Read once when the session's page opens (after `useCurrentProject`
 * has reset it to the chat), and written with `replaceState` as it changes
 * -- a view is not somewhere the back button should step through.
 */
function useViewInUrl(mode: ViewMode, setMode: (mode: ViewMode) => void, identity: string) {
  const restored = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (restored.current === identity) return
    restored.current = identity
    const wanted = new URL(window.location.href).searchParams.get("view") as ViewMode | null
    if (wanted && LINKED_VIEWS.has(wanted)) setMode(wanted)
    // Once per session page; `setMode` is stable in what it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  React.useEffect(() => {
    if (restored.current !== identity) return
    const url = new URL(window.location.href)
    const current = url.searchParams.get("view")
    const next = LINKED_VIEWS.has(mode) ? mode : null
    if (current === next) return
    if (next) url.searchParams.set("view", next)
    else url.searchParams.delete("view")
    window.history.replaceState(window.history.state, "", url)
  }, [mode, identity])
}
