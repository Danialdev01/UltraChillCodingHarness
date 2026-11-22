"use client"

import * as React from "react"
import { CopyIcon, ExternalLinkIcon, FolderIcon, SearchIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { DeleteProjectDialog } from "@/components/on-demand"
import { useSessionActions } from "@/components/session-sidebar/use-session-actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { qk } from "@/lib/query-keys"
import { useToast } from "@/lib/realtime"
import { projectPageHref } from "@/lib/sections"
import type { Project, Workspace } from "@/lib/session"
import { statusOf, type SidebarSession } from "@/lib/session-sidebar"
import { useInvalidate } from "@/lib/use-invalidate"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The session's own menu, opened from its title in the top bar: the same
 * verbs as its card in the sidebar -- rename, pin, archive, settle -- through
 * the same dialogs (`useSessionActions`), plus copying its branch and opening
 * it in another tab -- and the files, search and settings the bar's right
 * end drops when it is narrow.
 */
export function SessionMenu({
  workspace,
  projects,
  project,
  session,
  branch,
  trigger,
}: {
  workspace: Workspace
  projects: readonly Project[]
  /** The project on screen: in a session workspace, the session itself. */
  project: Project
  session: SidebarSession | null
  branch: string | null
  trigger: React.ReactElement
}) {
  const sessionWorkspace = workspace.kind === "session"
  const { actionsFor, dialogs } = useSessionActions({ workspace, projects, activeProjectHash: project.hash })
  const ws = useWorkspaceHash()
  const router = useTransitionRouter()
  const invalidate = useInvalidate()
  const toast = useToast()
  // The panel's own project: in a session it is the session's worktree.
  const { project: tree, closeFiles, filesOpen, openFiles, searchOpen, openSearch, closeSearch } = useFilesPanel()
  const [deleting, setDeleting] = React.useState(false)

  const actions = session ? actionsFor(session, statusOf(session)) : []
  const settled = session?.settleState === "settled"

  async function copyBranch() {
    if (!branch) return
    try {
      await navigator.clipboard.writeText(branch)
      toast({ title: `Copied ${branch}` })
    } catch {
      toast({ title: "Could not copy the branch name", tone: "error" })
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="start" className="w-56">
          {actions.map((action, i) =>
            action === "separator" ? (
              <DropdownMenuSeparator key={`sep-${i}`} />
            ) : (
              <DropdownMenuItem
                key={action.label}
                disabled={action.disabled}
                variant={action.destructive ? "destructive" : undefined}
                onClick={action.onSelect}
              >
                {action.icon && <action.icon className={action.destructive ? undefined : "text-muted-foreground"} />}
                <span>{action.label}</span>
              </DropdownMenuItem>
            ),
          )}
          {actions.length > 0 && <DropdownMenuSeparator />}
          {branch && (
            <DropdownMenuItem onClick={() => void copyBranch()}>
              <CopyIcon className="text-muted-foreground" />
              <span className="min-w-0 truncate">Copy branch name</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => window.open(window.location.href, "_blank", "noopener")}>
            <ExternalLinkIcon className="text-muted-foreground" />
            <span>Open in new tab</span>
          </DropdownMenuItem>
          {/* What the bar's right end drops when it is narrow. The column
              they open is not there on a phone at all. */}
          <DropdownMenuSeparator className="max-md:hidden" />
          <DropdownMenuItem className="max-md:hidden" disabled={!tree} onClick={() => (filesOpen ? closeFiles() : tree && openFiles(tree))}>
            <FolderIcon className="text-muted-foreground" />
            <span>{filesOpen ? "Hide files" : "Show files"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="max-md:hidden" disabled={!tree} onClick={() => (searchOpen ? closeSearch() : openSearch())}>
            <SearchIcon className="text-muted-foreground" />
            <span>{searchOpen ? "Hide search" : "Search files"}</span>
          </DropdownMenuItem>
          {!sessionWorkspace && (
            <DropdownMenuItem onClick={() => router.push(projectPageHref(ws, project.hash, "manage"))}>
              <SettingsIcon className="text-muted-foreground" />
              <span>Project settings</span>
            </DropdownMenuItem>
          )}
          {/* A session workspace's session is its own project, and can go
              before it is settled -- files and all. */}
          {sessionWorkspace && !settled && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon />
                <span>Delete</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialogs}
      {sessionWorkspace && (
        <DeleteProjectDialog
          project={deleting ? project : null}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => {
            // The page on screen is the session that no longer exists.
            closeFiles()
            router.push(`/${ws}`)
            invalidate(qk.bootstrap(), qk.projects.all, qk.sessions.all)
          }}
        />
      )}
    </>
  )
}
