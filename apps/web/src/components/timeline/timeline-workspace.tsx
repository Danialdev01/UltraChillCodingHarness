"use client"

import * as React from "react"
import { GanttChartIcon, PlusIcon } from "lucide-react"

import { TimelineChartSkeleton } from "@/components/page-skeletons"
import { GanttChart, HEADER_HEIGHT, ROW_HEIGHT } from "@/components/timeline/gantt-chart"
import { TaskDialog, type TaskDialogState } from "@/components/timeline/task-dialog"
import { Button } from "@/components/ui/button"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import { useProjectEvents, usePresenceLocation } from "@/lib/realtime"
import { computeRange, durationDays, localToday, PX_PER_DAY, type Zoom } from "@/lib/gantt"
import type { Project } from "@/lib/session"
import {
  createTimelineTask,
  deleteTimelineTask,
  updateTimelineTask,
  type TimelineTask,
  type TimelineTaskInput,
  type TimelineTaskPatch,
} from "@/lib/timeline-api"
import { cn } from "@/lib/utils"

const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
]

/**
 * A project's timeline: its tasks as a Gantt chart.
 *
 * The list on the left and the chart on the right are two columns of one
 * scrolling box, sharing a row height, so a task's name and its bar are
 * always level. Only the chart scrolls sideways.
 *
 * Writes are optimistic: a dragged bar stays where it was dropped while the
 * save is in flight, and goes back only if the server refuses.
 */
export function TimelineWorkspace({ project }: { project: Project }) {
  // Cached: coming back to the chart paints it at once, then revalidates.
  const query = projectQueries.timeline(project.hash)
  const [tasks, setTasks, reload, loadState] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
  })
  const [error, setError] = React.useState<string | null>(null)
  usePresenceLocation(project.id, "timeline")
  const [zoom, setZoom] = React.useState<Zoom>("week")
  const [dialog, setDialog] = React.useState<TaskDialogState>(null)
  const [busy, setBusy] = React.useState(false)
  // Read once per mount, not per render: a chart open across midnight
  // would otherwise shift its "today" line mid-drag.
  const [today] = React.useState(localToday)

  React.useEffect(() => {
    setError(loadState.error ? loadState.error.message : null)
  }, [loadState.error])

  // Other tabs, and other people: a `timeline.changed` on the project
  // topic reloads the chart, unless it names a version this tab wrote.
  const versions = React.useRef(new Map<string, string>())
  versions.current = new Map((tasks ?? []).map((t) => [t.id, t.updatedAt]))

  useProjectEvents(project.id, (event) => {
    if (event.type !== "timeline.changed") return
    if (event.change === "updated" && versions.current.get(event.taskId) === event.updatedAt) return
    void reload()
  })

  /** Replaces one task in place, keeping the order the server gave. */
  function put(task: TimelineTask) {
    setTasks((current) => (current ?? []).map((t) => (t.id === task.id ? task : t)))
  }

  async function save(input: TimelineTaskInput) {
    setBusy(true)
    try {
      if (dialog?.mode === "edit") {
        put(await updateTimelineTask(project.hash, dialog.task.id, input))
      } else {
        const created = await createTimelineTask(project.hash, input)
        setTasks((current) => [...(current ?? []), created])
      }
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  async function remove(task: TimelineTask) {
    setBusy(true)
    try {
      await deleteTimelineTask(project.hash, task.id)
      setTasks((current) =>
        (current ?? [])
          .filter((t) => t.id !== task.id)
          // The server clears the arrows into a deleted task; do the same
          // here so none is drawn to a bar that is gone.
          .map((t) => (t.dependsOnId === task.id ? { ...t, dependsOnId: null } : t)),
      )
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  /** A drag's result: shown at once, saved behind it, undone if refused. */
  function commit(task: TimelineTask, patch: TimelineTaskPatch) {
    put({ ...task, ...patch })
    updateTimelineTask(project.hash, task.id, patch).then(put, (e: unknown) => {
      put(task)
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  const pxPerDay = PX_PER_DAY[zoom]
  const range = React.useMemo(() => computeRange(tasks ?? [], today), [tasks, today])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <GanttChartIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Timeline</span>
        {tasks && (
          <span className="text-muted-foreground text-xs">
            · {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
        )}
        <div className="flex-1" />
        <div
          role="tablist"
          aria-label="Zoom"
          className="bg-muted/40 flex items-center gap-0.5 rounded-lg border p-0.5"
        >
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              type="button"
              role="tab"
              aria-selected={zoom === z.id}
              onClick={() => setZoom(z.id)}
              className={cn(
                "h-6 rounded-md px-2 text-xs transition-colors",
                zoom === z.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setDialog({ mode: "create" })} disabled={tasks === null}>
          <PlusIcon data-icon="inline-start" />
          Add task
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      {tasks === null ? <TimelineChartSkeleton /> : tasks.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-sm">
          <GanttChartIcon className="text-muted-foreground size-8" />
          <p>Nothing on the timeline yet.</p>
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "create" })}>
            <PlusIcon data-icon="inline-start" />
            Add the first task
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-auto">
          {/* The task list: sticky on the left so it stays put while the
              chart scrolls sideways under it. */}
          <div className="bg-background sticky left-0 z-10 w-64 shrink-0 border-r">
            <div
              className="text-muted-foreground flex items-end border-b px-3 pb-2 text-xs"
              style={{ height: HEADER_HEIGHT }}
            >
              Task
            </div>
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => setDialog({ mode: "edit", task })}
                className="hover:bg-muted/50 flex w-full items-center gap-2 border-b px-3 text-left"
                style={{ height: ROW_HEIGHT }}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: `var(--ucch-note-${task.colour})` }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {durationDays(task)}d · {task.progress}%
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <GanttChart
              tasks={tasks}
              range={range}
              zoom={zoom}
              pxPerDay={pxPerDay}
              today={today}
              onOpen={(task) => setDialog({ mode: "edit", task })}
              onCommit={commit}
            />
          </div>
        </div>
      )}

      <TaskDialog
        state={dialog}
        tasks={tasks ?? []}
        busy={busy}
        onClose={() => setDialog(null)}
        onSave={save}
        onDelete={remove}
      />
    </div>
  )
}
