"use client"

import * as React from "react"
import {
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { DeleteProjectDialog, RenameSessionDialog } from "@/components/on-demand"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { projectPageHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The two sidebar buttons, at the right end of the view switcher.
 *
 * They are not part of the switcher and are deliberately not merged into it:
 * the switcher chooses which half of the project you are looking at, and these
 * say what is in the column beside it. Reading the files while the chat is open
 * is the common case -- asking about a file you can see -- and until these
 * existed the tree could only be reached from the project's menu in the sidebar,
 * three clicks away from the page it belongs to.
 *
 * Both stay put in every view, the terminal included: a shell with the tree
 * beside it is just a narrower shell, and having to leave the terminal before
 * you could look at a file was the wrong trade.
 *
 * A panel glyph rather than a folder tree for the first one: the switcher's own
 * Files tab is a folder tree, and two of those side by side read as one control
 * drawn twice. It points at where the column comes in from, and flips once the
 * tree is in it.
 *
 * Hidden on small screens along with the column they control, so neither is ever
 * a button that does nothing.
 *
 * In a session a settings menu follows them: the session's own actions, which
 * used to hide behind a 3-dot button on every card in the sidebar. In a
 * project a settings button follows them instead, to the project's Manage
 * page, which no longer has a row under the project in the sidebar.
 */
export function SidebarToggles({ session = false }: { session?: boolean }) {
  const { project, filesOpen, searchOpen, openFiles, closeFiles, openSearch, closeSearch } =
    useFilesPanel()

  const TreeIcon = filesOpen ? FolderOpenIcon : FolderIcon

  return (
    <>
      {/* A rule rather than a gap: it is what says the buttons beside it are
          states and not two more places to go. */}
      <span aria-hidden className="bg-border mx-0.5 hidden h-4 w-px md:block" />

      <SidebarButton
        label={filesOpen ? "Hide the file explorer" : "Show the file explorer"}
        pressed={filesOpen}
        disabled={!project}
        onToggle={() => (filesOpen ? closeFiles() : project && openFiles(project))}
        icon={TreeIcon}
      />

      <SidebarButton
        label={searchOpen ? "Hide the file search" : "Search all files"}
        pressed={searchOpen}
        disabled={!project}
        onToggle={() => (searchOpen ? closeSearch() : openSearch())}
        icon={SearchIcon}
      />

      {session && project && <SessionSettingsMenu session={project} />}
      {!session && project && <ProjectSettingsLink project={project} />}
    </>
  )
}

/** The project's Manage page: what it has used, and where its repository lives. */
function ProjectSettingsLink({ project }: { project: Project }) {
  const ws = useWorkspaceHash()
  return (
    <TransitionLink
      href={projectPageHref(ws, project.hash, "manage")}
      title="Project settings"
      className="text-muted-foreground hover:text-foreground hidden size-7 items-center justify-center rounded-md transition-colors md:flex"
    >
      <SettingsIcon className="size-3.5" />
      <span className="sr-only">Settings for {project.name}</span>
    </TransitionLink>
  )
}

/** Rename, open the files of, or delete the session on screen. */
function SessionSettingsMenu({ session }: { session: Project }) {
  const { openFiles, closeFiles } = useFilesPanel()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [renaming, setRenaming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title="Session settings"
          className="text-muted-foreground hover:text-foreground aria-expanded:bg-background aria-expanded:text-foreground aria-expanded:shadow-sm hidden size-7 items-center justify-center rounded-md transition-colors md:flex"
        >
          <SettingsIcon className="size-3.5" />
          <span className="sr-only">Settings for {session.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <PencilIcon className="text-muted-foreground" />
            <span>Rename</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openFiles(session)}>
            <FolderTreeIcon className="text-muted-foreground" />
            <span>Open Files</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2Icon />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameSessionDialog
        session={renaming ? session : null}
        onOpenChange={setRenaming}
        onRenamed={() => router.refresh()}
      />
      <DeleteProjectDialog
        project={deleting ? session : null}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          // The page on screen is the session that no longer exists.
          closeFiles()
          router.push(`/${ws}`)
          router.refresh()
        }}
      />
    </>
  )
}

function SidebarButton({
  label,
  pressed,
  disabled,
  onToggle,
  icon: Icon,
}: {
  label: string
  pressed: boolean
  disabled: boolean
  onToggle: () => void
  icon: typeof SearchIcon
}) {
  return (
    <button
      type="button"
      // The state, not the action, so it is `aria-pressed` rather than a
      // changed label: the icon stays put and lights up.
      aria-pressed={pressed}
      disabled={disabled}
      title={label}
      onClick={onToggle}
      className={cn(
        "hidden size-7 items-center justify-center rounded-md transition-colors md:flex",
        "text-muted-foreground hover:text-foreground disabled:opacity-50",
        "aria-pressed:bg-background aria-pressed:text-ucch-active aria-pressed:shadow-sm",
      )}
    >
      <Icon className="size-3.5" />
      <span className="sr-only">{label}</span>
    </button>
  )
}
