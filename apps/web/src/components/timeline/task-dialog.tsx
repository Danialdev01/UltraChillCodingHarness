"use client"

import * as React from "react"
import { TIMELINE_COLOURS, TIMELINE_TITLE_MAX, type TimelineColour } from "@ucch/protocol"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { durationDays, fromDay, localToday, toDay } from "@/lib/gantt"
import type { TimelineTask, TimelineTaskInput } from "@/lib/timeline-api"
import { cn } from "@/lib/utils"

/** What the dialog is open for: a blank task, or one already on the chart. */
export type TaskDialogState = { mode: "create" } | { mode: "edit"; task: TimelineTask } | null

/**
 * The form behind a bar: title, dates, progress, colour, and the task an
 * arrow comes from. One dialog for adding and editing, since the fields are
 * the same and only the buttons differ.
 */
export function TaskDialog({
  state,
  tasks,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  state: TaskDialogState
  /** Every task on the chart, for the dependency picker. */
  tasks: readonly TimelineTask[]
  busy: boolean
  onClose: () => void
  onSave: (input: TimelineTaskInput) => Promise<void>
  onDelete: (task: TimelineTask) => Promise<void>
}) {
  const editing = state?.mode === "edit" ? state.task : null

  const [title, setTitle] = React.useState("")
  const [startsOn, setStartsOn] = React.useState("")
  const [endsOn, setEndsOn] = React.useState("")
  const [progress, setProgress] = React.useState(0)
  const [colour, setColour] = React.useState<TimelineColour>("blue")
  const [dependsOnId, setDependsOnId] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)

  // The fields follow whichever task the dialog was opened for; a fresh one
  // starts today and runs a week, which is at least a bar to look at.
  React.useEffect(() => {
    if (!state) return
    if (state.mode === "edit") {
      setTitle(state.task.title)
      setStartsOn(state.task.startsOn)
      setEndsOn(state.task.endsOn)
      setProgress(state.task.progress)
      setColour(state.task.colour)
      setDependsOnId(state.task.dependsOnId ?? "")
    } else {
      const today = localToday()
      setTitle("")
      setStartsOn(today)
      setEndsOn(fromDay(toDay(today) + 6))
      setProgress(0)
      setColour("blue")
      setDependsOnId("")
    }
    setError(null)
  }, [state])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = title.trim()
    if (!name) return setError("Give the task a name.")
    if (!startsOn || !endsOn) return setError("Both dates are needed.")
    if (endsOn < startsOn) return setError("The task cannot end before it starts.")
    setError(null)
    try {
      await onSave({
        title: name,
        startsOn,
        endsOn,
        progress,
        colour,
        dependsOnId: dependsOnId || null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove() {
    if (!editing) return
    try {
      await onDelete(editing)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const candidates = tasks.filter((t) => t.id !== editing?.id)
  const days = startsOn && endsOn && endsOn >= startsOn ? durationDays({ startsOn, endsOn }) : 0

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Change the bar, or take it off the chart."
                : "A bar on the chart, from one day to another."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              autoFocus
              value={title}
              maxLength={TIMELINE_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What has to happen"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="task-start">Starts</Label>
              <Input
                id="task-start"
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-end">
                Ends
                {days > 0 && (
                  <span className="text-muted-foreground font-normal">
                    · {days} {days === 1 ? "day" : "days"}
                  </span>
                )}
              </Label>
              <Input
                id="task-end"
                type="date"
                value={endsOn}
                min={startsOn || undefined}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="task-progress">
              Progress <span className="text-muted-foreground font-normal">· {progress}%</span>
            </Label>
            <input
              id="task-progress"
              type="range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              className="accent-ucch-active w-full"
            />
          </div>

          <div className="grid gap-2">
            <Label>Colour</Label>
            <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
              {TIMELINE_COLOURS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={colour === name}
                  aria-label={name}
                  title={name}
                  onClick={() => setColour(name)}
                  style={{ backgroundColor: `var(--ucch-note-${name})` }}
                  className={cn(
                    "size-6 rounded-full border-2 border-transparent transition-transform",
                    colour === name && "border-foreground scale-110",
                  )}
                />
              ))}
            </div>
          </div>

          {candidates.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="task-depends">Comes after</Label>
              <select
                id="task-depends"
                value={dependsOnId}
                onChange={(e) => setDependsOnId(e.target.value)}
                className="border-input bg-background h-8 rounded-md border px-2 text-sm"
              >
                <option value="">Nothing in particular</option>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}

          <DialogFooter className="sm:justify-between">
            {editing ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {editing ? "Save" : "Add task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
