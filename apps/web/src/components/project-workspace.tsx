"use client"

import { ChatDock, ChatPortal } from "@/components/chat-dock"
import { CodeEditor } from "@/components/code-editor"
import { useCurrentProject, useFilesPanel } from "@/components/files-panel"
import { ProjectChat } from "@/components/project-chat"
import { TerminalView } from "@/components/terminal-view"
import type { Project } from "@/lib/session"

/**
 * A project's three views: the conversation, the files, and a shell.
 *
 * All are reached from the same URL rather than from separate routes,
 * because the tree stays open across the switch -- the mode is which half of
 * the same project view you are looking at, not where you are.
 */
export function ProjectWorkspace({ project }: { project: Project }) {
  useCurrentProject(project)
  const { mode, sidebar } = useFilesPanel()

  // ProjectChat holds the project's WebSocket subscription, so it stays
  // mounted and hidden rather than unmounting: switching to files and back
  // would otherwise tear down the socket and replay the event log. It is
  // rendered through a portal so the right-hand column can show the same
  // instance beside the editor; the dock here is where it sits otherwise.
  const docked = mode !== "chat" && sidebar === "chat"
  return (
    <>
      <ChatPortal>
        <ProjectChat project={project} />
      </ChatPortal>
      {!docked && (
        <ChatDock className={mode === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"} />
      )}
      {mode === "file" && <CodeEditor />}

      {/* Mounted alongside the chat rather than swapped in: a shell keeps
          running while you read the files, and its scrollback is still there
          when you come back. It connects nothing until the view is first
          opened. */}
      <div className={mode === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <TerminalView project={project} active={mode === "terminal"} />
      </div>

      {/* Nothing here yet: the view exists so the switcher has somewhere to go. */}
      {mode === "git" && <div className="flex min-h-0 flex-1 flex-col" />}
    </>
  )
}
