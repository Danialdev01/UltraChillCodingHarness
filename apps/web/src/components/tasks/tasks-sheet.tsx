"use client"

import * as React from "react"
import { useQueries } from "@tanstack/react-query"
import { ListTodoIcon, PlusIcon } from "lucide-react"
import type { ProjectTask } from "@ucch/protocol"

import { ListRowsSkeleton } from "@/components/page-skeletons"
import { TaskDialog, type TaskDialogState } from "@/components/tasks/task-dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useBootstrap } from "@/lib/queries/bootstrap"
import { projectQueries } from "@/lib/queries/project-data"
import { projectPageHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { createTask, type TaskInput } from "@/lib/tasks-api"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

import { STATUS_OF, STATUS_STYLE, type TaskListStatus } from "./task-card"

const FILTERS: ReadonlyArray<TaskListStatus | "all"> = ["all", "idea", "planning", "ongoing", "done"]

/**
 * Every task of the open workspace, newest change first, in a panel over the
 * right of the page: what it is, which project it is for, and how far along.
 *
 * Reads each project's board through the same cache the boards use, so the
 * realtime bridge (`realtime-cache.ts`) keeps this list live too.
 */
export function TasksSheet({
  open,
  onOpenChange,
  currentProjectHash,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The project picked when "New task" opens the dialog. */
  currentProjectHash?: string
}) {
  const ws = useWorkspaceHash()
  const bootstrap = useBootstrap(ws || null)
  const projects = React.useMemo(() => bootstrap.data?.projects ?? [], [bootstrap.data])
  const [filter, setFilter] = React.useState<TaskListStatus | "all">("all")
  const [dialog, setDialog] = React.useState<TaskDialogState>(null)
  const [saving, setSaving] = React.useState(false)

  const results = useQueries({
    queries: projects.map((p) => {
      const q = projectQueries.tasks(p.hash)
      return { queryKey: q.queryKey, queryFn: q.queryFn, enabled: open }
    }),
  })

  // "Loaded" apart from "empty": until every board has answered once, the
  // list is a skeleton rather than a flash of "No tasks yet".
  const loading = bootstrap.isPending || results.some((r) => r.isPending)
  const failed = projects.filter((_, i) => results[i]?.isError)

  const rows = React.useMemo(() => {
    const all: { task: ProjectTask; project: Project }[] = []
    projects.forEach((project, i) => {
      for (const task of results[i]?.data ?? []) all.push({ task, project })
    })
    return all.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
    // `results` is a new array every render; its data is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, ...results.map((r) => r.data)])

  const counts = React.useMemo(() => {
    const c: Record<TaskListStatus | "all", number> = { all: rows.length, idea: 0, planning: 0, ongoing: 0, done: 0 }
    for (const { task } of rows) c[STATUS_OF[task.stage]]++
    return c
  }, [rows])

  const shown = filter === "all" ? rows : rows.filter(({ task }) => STATUS_OF[task.stage] === filter)

  async function save(input: TaskInput, projectHash: string) {
    setSaving(true)
    try {
      // The `task.changed` event this announces puts it in the list.
      await createTask(projectHash, input)
      setDialog(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="gap-0 data-[side=right]:sm:max-w-md">
          <SheetHeader className="border-b pr-12">
            <div className="flex items-center gap-2">
              <SheetTitle>Tasks</SheetTitle>
              <button
                type="button"
                onClick={() => setDialog({ mode: "create" })}
                disabled={projects.length === 0}
                className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring ml-auto inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-2 disabled:opacity-40"
              >
                <PlusIcon className="size-3.5" /> New task
              </button>
            </div>
            <SheetDescription>Every task in this workspace.</SheetDescription>
            <div role="tablist" aria-label="Filter by status" className="mt-2 flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs",
                    filter === f ? "bg-foreground text-background border-transparent" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f === "all" ? "All" : STATUS_STYLE[f].label}
                  <span className="tabular-nums">{counts[f]}</span>
                </button>
              ))}
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {failed.length > 0 && (
              <p className="text-destructive px-2 py-1 text-xs">
                Could not load the tasks of {failed.map((p) => p.name).join(", ")}.
              </p>
            )}
            {loading ? (
              <ListRowsSkeleton rows={6} className="flex flex-col gap-3 p-2" />
            ) : shown.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-12 text-center text-sm">
                <ListTodoIcon className="size-6" />
                {rows.length === 0 ? "No tasks yet." : "No tasks with this status."}
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {shown.map(({ task, project }) => {
                  const status = STATUS_STYLE[STATUS_OF[task.stage]]
                  return (
                    <li key={task.id}>
                      <TransitionLink
                        href={projectPageHref(ws, project.hash, "tasks")}
                        onClick={() => onOpenChange(false)}
                        className="hover:bg-muted focus-visible:ring-ring grid gap-1 rounded-lg border p-3 outline-none focus-visible:ring-2"
                      >
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-sm font-medium break-words">{task.title}</span>
                          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium", status.className)}>
                            {status.label}
                          </span>
                        </span>
                        {task.description && (
                          <span className="text-muted-foreground line-clamp-2 text-xs break-words">{task.description}</span>
                        )}
                        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-2xs">
                          <span className="truncate">{project.name}</span>
                          <span className="bg-muted shrink-0 rounded px-1 font-mono" title="Project ID">
                            {project.hash}
                          </span>
                        </span>
                      </TransitionLink>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <TaskDialog
        state={dialog}
        projects={projects}
        projectHash={currentProjectHash}
        busy={saving}
        onClose={() => setDialog(null)}
        onSave={save}
      />
    </>
  )
}
