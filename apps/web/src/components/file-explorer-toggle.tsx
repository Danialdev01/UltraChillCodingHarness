"use client"

import * as React from "react"
import { FolderIcon, FolderOpenIcon, SearchIcon, SettingsIcon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { Hint, ICON_BUTTON, IconButton } from "@/components/topbar/primitives"
import { projectPageHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The utilities at the right end of the top bar: the file tree, the file
 * search, and the project's settings.
 *
 * The first two say what is in the column beside the page -- a state, not a
 * destination -- so they light up while their column is open. Reading the
 * files while the chat is open is the common case, asking about a file you
 * can see, and both stay put in every view, the terminal included.
 *
 * Hidden below `md` along with the column they control, so neither is ever
 * a button that does nothing -- and on a bar too narrow for them, when the
 * session's menu carries them instead.
 */
export function FilesButton() {
  const { project, filesOpen, openFiles, closeFiles } = useFilesPanel()
  const TreeIcon = filesOpen ? FolderOpenIcon : FolderIcon
  return (
    <IconButton
      label={filesOpen ? "Hide files" : "Files"}
      active={filesOpen}
      aria-pressed={filesOpen}
      disabled={!project}
      onClick={() => (filesOpen ? closeFiles() : project && openFiles(project))}
      className="hidden md:@3xl:inline-flex"
    >
      <TreeIcon />
    </IconButton>
  )
}

/**
 * Search across the project's files, in the same column. The workspace-wide
 * palette (⌘K) is the sidebar's command bar, a hand's width to the left.
 */
export function SearchButton() {
  const { project, searchOpen, openSearch, closeSearch } = useFilesPanel()
  return (
    <IconButton
      label={searchOpen ? "Hide search" : "Search files"}
      active={searchOpen}
      aria-pressed={searchOpen}
      disabled={!project}
      onClick={() => (searchOpen ? closeSearch() : openSearch())}
      className="hidden md:@3xl:inline-flex"
    >
      <SearchIcon />
    </IconButton>
  )
}

/** The project's Manage page: what it has used, and where its repository lives. */
export function ProjectSettingsButton({ project, className }: { project: Project; className?: string }) {
  const ws = useWorkspaceHash()
  const label = `Settings for ${project.name}`
  return (
    <Hint label="Settings">
      <TransitionLink
        href={projectPageHref(ws, project.hash, "manage")}
        aria-label={label}
        className={cn(ICON_BUTTON, className)}
      >
        <SettingsIcon />
      </TransitionLink>
    </Hint>
  )
}
