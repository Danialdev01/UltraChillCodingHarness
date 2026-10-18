"use client"

import * as React from "react"
import { AlertTriangleIcon, Loader2Icon, MessageCircleQuestionIcon, PaperclipIcon } from "lucide-react"
import type { ProjectTask, TaskStage } from "@ucch/protocol"

import { cn } from "@/lib/utils"

export const STAGE_LABELS: Record<TaskStage, string> = {
  idea: "Idea",
  research: "Research",
  ongoing: "Ongoing",
  verification: "Verification",
  done: "Done",
}

/** One card on the board: its title, and what the pipeline is doing with it. */
export function TaskCard({
  task,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: ProjectTask
  dragging: boolean
  onOpen: () => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  // A card the AI is holding stays put: dragging it would pull the work
  // out from under the agent mid-turn.
  const draggable = task.status !== "running"

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-task-id={task.id}
      className={cn(
        "bg-card hover:border-foreground/30 grid w-full gap-1.5 rounded-lg border p-3 text-left shadow-xs transition-colors",
        draggable && "cursor-grab active:cursor-grabbing",
        dragging && "border-dashed bg-muted shadow-none",
        task.status === "needs_input" && "border-warning",
        task.status === "failed" && "border-destructive/60",
      )}
    >
      <span className="line-clamp-3 text-sm font-medium break-words">{task.title}</span>
      {task.description && (
        <span className="text-muted-foreground line-clamp-2 text-xs break-words">{task.description}</span>
      )}
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge task={task} />
        {task.references.length > 0 && (
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <PaperclipIcon className="size-3" /> {task.references.length}
          </span>
        )}
        {task.attempts > 1 && <span className="text-muted-foreground">attempt {task.attempts}</span>}
      </span>
    </button>
  )
}

function StatusBadge({ task }: { task: ProjectTask }) {
  switch (task.status) {
    case "running":
      return (
        <span className="text-primary inline-flex items-center gap-1">
          <Loader2Icon className="size-3 animate-spin" /> {runningLabel(task.stage)}
        </span>
      )
    case "needs_input":
      return (
        <span className="inline-flex items-center gap-1 text-warning">
          <MessageCircleQuestionIcon className="size-3" /> Needs your input
        </span>
      )
    case "failed":
      return (
        <span className="text-destructive inline-flex items-center gap-1">
          <AlertTriangleIcon className="size-3" /> Failed
        </span>
      )
    default:
      return null
  }
}

function runningLabel(stage: TaskStage): string {
  switch (stage) {
    case "research":
      return "Researching"
    case "ongoing":
      return "Working"
    case "verification":
      return "Verifying"
    default:
      return "Running"
  }
}
