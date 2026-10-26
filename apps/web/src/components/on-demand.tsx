"use client"

import dynamic from "next/dynamic"

import { TreeRowsSkeleton } from "@/components/page-skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The parts of the app shell that nobody sees until they ask for them: the
 * creation and settings dialogs, the search panel, and the cmdk lists behind
 * the shell's palette and pickers.
 *
 * Every page loads the shell's JavaScript before it runs, so whatever sits
 * in the shell's import graph is paid for on every first load -- and these
 * dialogs, with their forms, comboboxes and validators, were the larger part
 * of it. Imported from here instead, each becomes a chunk of its own that
 * arrives after the page is interactive. A dialog renders nothing while
 * shut, so it needs no placeholder; the search panel and the picker lists,
 * drawn inside a popover that is already open, show rows.
 * The boot preload (`lib/preload.ts`) loads them all (`ON_DEMAND`), so the
 * first click finds them there.
 *
 * `ssr: false` because none of them is open in a server render.
 */

const loaders = {
  newProject: () => import("@/components/new-project-dialog"),
  newDatabase: () => import("@/components/new-database-dialog"),
  newWorkspace: () => import("@/components/new-workspace-dialog"),
  newSession: () => import("@/components/new-session-dialog"),
  manageWorkspace: () => import("@/components/manage-workspace-dialog"),
  connectionSettings: () => import("@/components/database/connection-settings-dialog"),
  createDatabase: () => import("@/components/database/create-database-dialog"),
  renameSession: () => import("@/components/rename-session-dialog"),
  deleteProject: () => import("@/components/delete-project-dialog"),
  task: () => import("@/components/tasks/task-dialog"),
  preview: () => import("@/components/preview-dialog"),
  search: () => import("@/components/search-panel"),
  quickMenu: () => import("@/components/quick-menu-palette"),
  workspaceList: () => import("@/components/workspace-list"),
  viewModeList: () => import("@/components/view-mode-list"),
  filesTree: () => import("@/components/files-tree"),
}

/** Every chunk above, for the warmup to fetch while the page is idle. */
export const ON_DEMAND: ReadonlyArray<() => Promise<unknown>> = Object.values(loaders)

export const NewProjectDialog = dynamic(() => loaders.newProject().then((m) => m.NewProjectDialog), { ssr: false })
export const NewDatabaseDialog = dynamic(() => loaders.newDatabase().then((m) => m.NewDatabaseDialog), { ssr: false })
export const NewWorkspaceDialog = dynamic(() => loaders.newWorkspace().then((m) => m.NewWorkspaceDialog), { ssr: false })
export const NewSessionDialog = dynamic(() => loaders.newSession().then((m) => m.NewSessionDialog), { ssr: false })
export const ManageWorkspaceDialog = dynamic(() => loaders.manageWorkspace().then((m) => m.ManageWorkspaceDialog), { ssr: false })
export const ConnectionSettingsDialog = dynamic(() => loaders.connectionSettings().then((m) => m.ConnectionSettingsDialog), { ssr: false })
export const CreateDatabaseDialog = dynamic(() => loaders.createDatabase().then((m) => m.CreateDatabaseDialog), { ssr: false })
export const RenameSessionDialog = dynamic(() => loaders.renameSession().then((m) => m.RenameSessionDialog), { ssr: false })
export const DeleteProjectDialog = dynamic(() => loaders.deleteProject().then((m) => m.DeleteProjectDialog), { ssr: false })
export const TaskDialog = dynamic(() => loaders.task().then((m) => m.TaskDialog), { ssr: false })
export const PreviewDialog = dynamic(() => loaders.preview().then((m) => m.PreviewDialog), { ssr: false })
export const QuickMenuPalette = dynamic(() => loaders.quickMenu().then((m) => m.QuickMenuPalette), { ssr: false })

/** Rows of a picker list while its chunk is on the way. */
function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  )
}

export const WorkspaceList = dynamic(() => loaders.workspaceList().then((m) => m.WorkspaceList), {
  ssr: false,
  loading: () => <ListSkeleton rows={4} />,
})
export const ViewModeList = dynamic(() => loaders.viewModeList().then((m) => m.ViewModeList), {
  ssr: false,
  loading: () => <ListSkeleton rows={3} />,
})
export const FilesTree = dynamic(() => loaders.filesTree().then((m) => m.FilesTree), {
  ssr: false,
  loading: () => <TreeRowsSkeleton />,
})
export const SearchPanel = dynamic(() => loaders.search().then((m) => m.SearchPanel), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col gap-2 p-3">
      {[64, 48, 80, 56].map((width) => (
        <Skeleton key={width} className="h-3.5" style={{ width: `${width}%` }} />
      ))}
    </div>
  ),
})
