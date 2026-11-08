"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import {
  PROJECT_COMMAND_ICONS,
  PROJECT_COMMAND_LABEL_MAX,
  PROJECT_COMMAND_MAX,
  PROJECT_COMMANDS_MAX,
} from "@ucch/protocol/plain"
import type { ProjectCommand } from "@ucch/protocol"

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
import { NativeSelect } from "@/components/ui/native-select"
import { saveCommands } from "@/lib/commands-api"
import { qk } from "@/lib/query-keys"
import type { Project } from "@/lib/session"
import { useInvalidate } from "@/lib/use-invalidate"

interface Row {
  /** Stable for React; the saved id is `id`, made from the label for a new row. */
  key: string
  id: string | null
  label: string
  command: string
  description: string
  icon: string
  cwd: string
}

function toRow(command: ProjectCommand): Row {
  return {
    key: command.id,
    id: command.id,
    label: command.label,
    command: command.command,
    description: command.description ?? "",
    icon: command.icon ?? "terminal",
    cwd: command.cwd ?? "",
  }
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "command"
  )
}

/** The rows as the file holds them: ids kept, new ones made unique from their labels. */
function toCommands(rows: Row[]): ProjectCommand[] {
  const used = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])))
  return rows.map((row) => {
    let id = row.id
    if (!id) {
      const base = slug(row.label)
      id = base
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`
      used.add(id)
    }
    return {
      id,
      label: row.label.trim(),
      command: row.command.trim(),
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
      ...(row.icon && row.icon !== "terminal" ? { icon: row.icon } : {}),
      ...(row.cwd.trim() && row.cwd.trim() !== "." ? { cwd: row.cwd.trim() } : {}),
    }
  })
}

/**
 * Adds, edits, orders and removes a project's command buttons. Saving writes
 * `.agent/commands.json`; the header follows through `resource.changed`.
 */
export function ManageCommandsDialog({
  project,
  open,
  onOpenChange,
  commands,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: ProjectCommand[]
}) {
  const [rows, setRows] = React.useState<Row[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const invalidate = useInvalidate()

  // Fresh from the file each time it opens, never a half-edit from last time.
  React.useEffect(() => {
    if (!open) return
    setRows(commands.length > 0 ? commands.map(toRow) : [blank()])
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on opening only
  }, [open])

  const update = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const move = (index: number, by: number) =>
    setRows((current) => {
      const next = [...current]
      const [row] = next.splice(index, 1)
      next.splice(index + by, 0, row!)
      return next
    })

  const filled = rows.filter((r) => r.label.trim() || r.command.trim())
  const incomplete = filled.some((r) => !r.label.trim() || !r.command.trim())

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (incomplete) {
      setError("Every command needs a label and a command line.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await saveCommands(project.hash, toCommands(filled))
      invalidate(qk.commands.all)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="min-w-0">
          <DialogHeader>
            <DialogTitle>Commands</DialogTitle>
            <DialogDescription>
              Buttons in the project bar that run a command in a new terminal tab, like <code>pnpm dev</code> or{" "}
              <code>pnpm test</code>. They are kept in <code>.agent/commands.json</code>, so agents can read and
              add to them too.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-4">
            {rows.map((row, i) => (
              <fieldset key={row.key} className="grid gap-2 rounded-lg border p-3" disabled={pending}>
                <div className="flex items-end gap-2">
                  <div className="grid min-w-0 flex-1 gap-1.5">
                    <Label htmlFor={`cmd-label-${row.key}`}>Label</Label>
                    <Input
                      id={`cmd-label-${row.key}`}
                      value={row.label}
                      maxLength={PROJECT_COMMAND_LABEL_MAX}
                      placeholder="Dev server"
                      onChange={(e) => update(row.key, { label: e.target.value })}
                    />
                  </div>
                  <div className="grid w-32 gap-1.5">
                    <Label htmlFor={`cmd-icon-${row.key}`}>Icon</Label>
                    <NativeSelect id={`cmd-icon-${row.key}`} value={row.icon} onChange={(icon) => update(row.key, { icon })}>
                      {PROJECT_COMMAND_ICONS.map((icon) => (
                        <option key={icon} value={icon}>
                          {icon}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUpIcon />
                      <span className="sr-only">Move up</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDownIcon />
                      <span className="sr-only">Move down</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    >
                      <Trash2Icon />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`cmd-line-${row.key}`}>Command</Label>
                  <Input
                    id={`cmd-line-${row.key}`}
                    value={row.command}
                    maxLength={PROJECT_COMMAND_MAX}
                    placeholder="pnpm dev"
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    onChange={(e) => update(row.key, { command: e.target.value })}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`cmd-desc-${row.key}`}>Description</Label>
                    <Input
                      id={`cmd-desc-${row.key}`}
                      value={row.description}
                      placeholder="Starts the app on port 3000"
                      onChange={(e) => update(row.key, { description: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`cmd-cwd-${row.key}`}>Folder</Label>
                    <Input
                      id={`cmd-cwd-${row.key}`}
                      value={row.cwd}
                      placeholder="/ (project root)"
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono"
                      onChange={(e) => update(row.key, { cwd: e.target.value })}
                    />
                  </div>
                </div>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || rows.length >= PROJECT_COMMANDS_MAX}
              onClick={() => setRows((current) => [...current, blank()])}
            >
              <PlusIcon />
              Add a command
            </Button>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function blank(): Row {
  return { key: crypto.randomUUID(), id: null, label: "", command: "", description: "", icon: "play", cwd: "" }
}
