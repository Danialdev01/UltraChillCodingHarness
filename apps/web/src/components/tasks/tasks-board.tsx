"use client"

import * as React from "react"
import { PlusIcon, SquareKanbanIcon } from "lucide-react"
import { TASK_STAGES, type ProjectTask, type TaskSettings, type TaskStage } from "@ucch/protocol"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCachedState } from "@/lib/queries/cached-state"
import { qk } from "@/lib/query-keys"
import { useProjectEvents } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import {
  answerTask,
  createTask,
  deleteTask,
  fetchTaskSettings,
  listTasks,
  moveTask,
  retryTask,
  updateTask,
  type TaskInput,
} from "@/lib/tasks-api"
import { cn } from "@/lib/utils"
import { projectPageHref } from "@/lib/sections"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { STAGE_LABELS, TaskCard } from "./task-card"
import { TaskDetailDialog } from "./task-detail-dialog"
import { TaskDialog, type TaskDialogState } from "./task-dialog"

/** The columns a person can drop a card into; the others are the AI's. */
const MANUAL: ReadonlySet<TaskStage> = new Set(["idea", "research", "done"])

const HINTS: Record<TaskStage, string> = {
  idea: "Waiting to be picked up",
  research: "The AI studies the task",
  ongoing: "The AI does the work",
  verification: "The AI checks the work",
  done: "Verified as complete",
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/**
 * A project's Tasks board: five columns, Idea to Done.
 *
 * A person writes todos into Idea and drags them to Research -- or Auto Run
 * does it on a schedule. From there the server's pipeline moves the card
 * itself, and this board follows along through `task.changed`.
 */
export function TasksBoard({ project, projects }: { project: Project; projects: Project[] }) {
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  // Cached: coming back to the board paints it at once, then revalidates.
  const [tasks, setTasks, reloadTasks, tasksState] = useCachedState(
    qk.tasks.list(project.hash),
    () => listTasks(project.hash),
    { persist: true },
  )
  const [settings, , reloadSettings] = useCachedState<TaskSettings>(qk.tasks.settings(project.hash), () =>
    fetchTaskSettings(project.hash),
  )
  const [error, setError] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<TaskDialogState>(null)
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dropAt, setDropAt] = React.useState<{ stage: TaskStage; index: number } | null>(null)

  const reload = reloadTasks
  React.useEffect(() => {
    setError(tasksState.error ? tasksState.error.message : null)
  }, [tasksState.error])

  const versions = React.useRef(new Map<string, string>())
  versions.current = new Map((tasks ?? []).map((t) => [t.id, t.updatedAt]))

  useProjectEvents(project.id, (event) => {
    if (event.type === "task.changed") {
      if (event.change === "updated" && versions.current.get(event.taskId) === event.updatedAt) return
      void reload()
    } else if (event.type === "resource.changed" && event.resource === "project_settings") {
      void reloadSettings()
    }
  })

  const columns = React.useMemo(() => {
    const byStage = new Map<TaskStage, ProjectTask[]>(TASK_STAGES.map((s) => [s, []]))
    for (const task of tasks ?? []) byStage.get(task.stage)?.push(task)
    for (const list of byStage.values()) list.sort((a, b) => a.position - b.position)
    return byStage
  }, [tasks])

  function put(task: ProjectTask) {
    setTasks((current) => {
      const list = current ?? []
      return list.some((t) => t.id === task.id) ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task]
    })
  }

  const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  async function save(input: TaskInput, hash: string) {
    setBusy(true)
    try {
      if (dialog?.mode === "edit") put(await updateTask(project.hash, dialog.task.id, input))
      else if (hash === project.hash) put(await createTask(hash, input))
      else {
        // Filed under another project: go to its board, where it now is.
        await createTask(hash, input)
        router.push(projectPageHref(ws, hash, "tasks"))
      }
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  /** Where a dragged card would land, as a position the server sorts by. */
  function positionAt(stage: TaskStage, index: number, movingId: string): number {
    const list = (columns.get(stage) ?? []).filter((t) => t.id !== movingId)
    const before = list[index - 1]
    const after = list[index]
    if (!before && !after) return 0
    if (!before) return after!.position - 1
    if (!after) return before.position + 1
    return (before.position + after.position) / 2
  }

  function drop(stage: TaskStage, index: number) {
    const task = tasks?.find((t) => t.id === dragId)
    setDragId(null)
    setDropAt(null)
    if (!task) return
    if (task.stage !== stage && !MANUAL.has(stage)) {
      setError("Ongoing and Verification are the AI's columns: move a card to Research and it gets there by itself.")
      return
    }
    const position = positionAt(stage, index, task.id)
    const previous = task
    put({ ...task, stage, position, ...(task.stage !== stage ? { status: "idle" as const } : {}) })
    moveTask(project.hash, task.id, stage, position).then(put, (e: unknown) => {
      put(previous)
      report(e)
    })
  }

  /** The index among a column's cards that the pointer is over. */
  function indexFromPointer(event: React.DragEvent, stage: TaskStage): number {
    const cards = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-task-id]"),
    ).filter((el) => el.dataset.taskId !== dragId)
    const index = cards.findIndex((el) => {
      const box = el.getBoundingClientRect()
      return event.clientY < box.top + box.height / 2
    })
    return index === -1 ? (columns.get(stage) ?? []).filter((t) => t.id !== dragId).length : index
  }

  const open = tasks?.find((t) => t.id === openId) ?? null
  const dragged = tasks?.find((t) => t.id === dragId) ?? null
  const autoRun = settings?.autoRun

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <SquareKanbanIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Tasks</span>
        {tasks && (
          <span className="text-muted-foreground text-xs">
            · {tasks.length} {tasks.length === 1 ? "todo" : "todos"}
          </span>
        )}
        <div className="flex-1" />
        <TransitionLink
          href={`${projectPageHref(ws, project.hash, "manage")}?tab=preferences`}
          className="text-muted-foreground hover:text-foreground hidden text-xs sm:inline"
        >
          {autoRun?.enabled
            ? `Auto Run: ${autoRun.days.map((d) => WEEKDAYS[d]).join(", ")} at ${autoRun.time}`
            : "Auto Run: off"}
        </TransitionLink>
        <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
          <PlusIcon /> New Todo
        </Button>
      </div>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 border-b px-4 py-2 text-sm">
          <span className="flex-1">{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {TASK_STAGES.map((stage) => {
          const list = columns.get(stage) ?? []
          const refused = dragged !== null && dragged.stage !== stage && !MANUAL.has(stage)
          return (
            <section
              key={stage}
              aria-label={STAGE_LABELS[stage]}
              className={cn(
                "bg-muted/30 flex min-w-60 flex-1 basis-0 flex-col rounded-xl border",
                dropAt?.stage === stage && !refused && "ring-primary/50 ring-2",
                refused && "bg-muted border-dashed",
              )}
              onDragOver={(event) => {
                if (!dragId || refused) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                const index = indexFromPointer(event, stage)
                if (dropAt?.stage !== stage || dropAt.index !== index) setDropAt({ stage, index })
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                drop(stage, indexFromPointer(event, stage))
              }}
            >
              <header className="flex items-baseline gap-2 px-3 pt-3 pb-2">
                <h2 className="text-sm font-medium">{STAGE_LABELS[stage]}</h2>
                <span className="text-muted-foreground text-xs">{list.length}</span>
                <span className="text-muted-foreground ml-auto truncate text-[11px]">{HINTS[stage]}</span>
              </header>
              <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {tasks === null ? (
                  <Skeleton className="h-16 rounded-lg" />
                ) : (
                  list.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      dragging={task.id === dragId}
                      onOpen={() => setOpenId(task.id)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move"
                        event.dataTransfer.setData("text/plain", task.id)
                        setDragId(task.id)
                      }}
                      onDragEnd={() => {
                        setDragId(null)
                        setDropAt(null)
                      }}
                    />
                  ))
                )}
                {stage === "idea" && tasks?.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setDialog({ mode: "create" })}
                    className="text-muted-foreground hover:text-foreground rounded-lg border border-dashed p-4 text-sm"
                  >
                    Add your first todo
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>

      <TaskDialog
        state={dialog}
        projects={projects}
        projectHash={project.hash}
        busy={busy}
        onClose={() => setDialog(null)}
        onSave={save}
      />

      <TaskDetailDialog
        task={dialog ? null : open}
        projectHash={project.hash}
        onClose={() => setOpenId(null)}
        onEdit={(task) => setDialog({ mode: "edit", task })}
        onAnswer={async (task, answer) => {
          put(await answerTask(project.hash, task.id, answer))
          setOpenId(null)
        }}
        onRetry={async (task) => put(await retryTask(project.hash, task.id))}
        onDelete={async (task) => {
          await deleteTask(project.hash, task.id)
          setTasks((current) => (current ?? []).filter((t) => t.id !== task.id))
          setOpenId(null)
        }}
      />
    </div>
  )
}
