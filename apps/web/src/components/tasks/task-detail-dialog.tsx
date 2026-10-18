"use client"

import * as React from "react"
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"
import { TASK_FEEDBACK_MAX, type ProjectTask } from "@ucch/protocol"

import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { taskThreadHref } from "@/lib/tasks-api"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { ReferenceIcon, referenceKey, referenceLabel } from "./task-dialog"
import { STAGE_LABELS } from "./task-card"

/**
 * Everything a card holds: what was asked, what the research found, what
 * the verifier said -- and, when it failed, the box to say why.
 */
export function TaskDetailDialog({
  task,
  projectHash,
  onClose,
  onEdit,
  onAnswer,
  onRetry,
  onDelete,
}: {
  task: ProjectTask | null
  projectHash: string
  onClose: () => void
  onEdit: (task: ProjectTask) => void
  onAnswer: (task: ProjectTask, answer: string) => Promise<void>
  onRetry: (task: ProjectTask) => Promise<void>
  onDelete: (task: ProjectTask) => Promise<void>
}) {
  const ws = useWorkspaceHash()
  const [answer, setAnswer] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setAnswer("")
    setError(null)
  }, [task?.id])

  async function run(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  const verification = task?.verification ?? null

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {task && (
          <div className="grid gap-5">
            <DialogHeader>
              <DialogTitle className="pr-6">{task.title}</DialogTitle>
              <DialogDescription>
                {STAGE_LABELS[task.stage]}
                {task.attempts > 1 ? ` · attempt ${task.attempts}` : ""}
                {task.status === "running" ? " · the AI is working on it" : ""}
              </DialogDescription>
            </DialogHeader>

            {task.description && (
              <section className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium uppercase">Description</h3>
                <p className="text-sm whitespace-pre-wrap">{task.description}</p>
              </section>
            )}

            {task.references.length > 0 && (
              <section className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium uppercase">References</h3>
                <ul className="grid gap-1">
                  {task.references.map((ref) => (
                    <li key={referenceKey(ref)} className="flex items-center gap-2 text-sm">
                      <ReferenceIcon reference={ref} />
                      {ref.kind === "url" ? (
                        <a href={ref.url} target="_blank" rel="noreferrer" className="truncate underline">
                          {ref.url}
                        </a>
                      ) : (
                        <span className="truncate">{referenceLabel(ref)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {task.lastError && task.status === "failed" && (
              <p className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
                {task.lastError}
              </p>
            )}

            {verification && (
              <section
                className={
                  verification.passed
                    ? "rounded-md border border-success bg-success-soft p-3"
                    : "rounded-md border border-warning bg-warning-soft p-3"
                }
              >
                <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
                  {verification.passed ? (
                    <CheckCircle2Icon className="size-4 text-success" />
                  ) : (
                    <XCircleIcon className="size-4 text-warning" />
                  )}
                  {verification.passed ? "Verified as done" : "Verification did not pass"}
                </h3>
                <p className="text-sm whitespace-pre-wrap">{verification.reason}</p>
                {verification.threadId && (
                  <TransitionLink
                    href={taskThreadHref(ws, projectHash, verification.threadId)}
                    className="text-muted-foreground mt-2 inline-flex items-center gap-1 text-xs underline"
                  >
                    <ExternalLinkIcon className="size-3" /> Open the verifier&apos;s thread
                  </TransitionLink>
                )}
              </section>
            )}

            {task.status === "needs_input" && (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const text = answer.trim()
                  if (!text) return setError("Say what is missing or wrong.")
                  void run(() => onAnswer(task, text))
                }}
              >
                <Label htmlFor="task-answer">Why is it not done?</Label>
                <Textarea
                  id="task-answer"
                  autoFocus
                  value={answer}
                  maxLength={TASK_FEEDBACK_MAX}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="What is still missing, or what should be done differently"
                  className="min-h-24"
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={pending}>
                    {pending && <Loader2Icon className="animate-spin" />}
                    Send back to Research
                  </Button>
                </div>
              </form>
            )}

            {task.research && (
              <section className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium uppercase">Research brief</h3>
                <div className="bg-muted/30 max-h-80 overflow-y-auto rounded-md border p-3">
                  <Markdown>{task.research}</Markdown>
                </div>
              </section>
            )}

            {task.feedback.length > 0 && (
              <section className="grid gap-2">
                <h3 className="text-muted-foreground text-xs font-medium uppercase">Earlier rounds</h3>
                {task.feedback.map((round, i) => (
                  <div key={round.at} className="rounded-md border p-3 text-sm">
                    <p className="text-muted-foreground mb-1 text-xs">Round {i + 1}</p>
                    <p>
                      <span className="font-medium">Verifier:</span> {round.reason}
                    </p>
                    <p>
                      <span className="font-medium">You:</span> {round.answer}
                    </p>
                  </div>
                ))}
              </section>
            )}

            {error && <p className="text-destructive text-sm">{error}</p>}

            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void run(() => onDelete(task))}
                >
                  <Trash2Icon /> Delete
                </Button>
                {task.status === "failed" && (
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => void run(() => onRetry(task))}>
                    <RotateCcwIcon /> Retry
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                {task.threadId && (
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<TransitionLink href={taskThreadHref(ws, projectHash, task.threadId)} />}
                  >
                    <MessageSquareIcon /> Open thread
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={task.status === "running"} onClick={() => onEdit(task)}>
                  <PencilIcon /> Edit
                </Button>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
