"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"
import { ColumnSpec, type ColumnInfo, type DatabaseEngine } from "@ucch/protocol"

import { errorText } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * A column as the form holds it: every field is text or a flag, and the
 * default is a mode plus a value, so the same draft serves a fresh column
 * and one read back from the server.
 */
export interface ColumnDraft {
  name: string
  type: string
  nullable: boolean
  autoincrement: boolean
  primaryKey: boolean
  unique: boolean
  defaultMode: "none" | "literal" | "expression"
  defaultValue: string
  comment: string
}

export function emptyColumn(): ColumnDraft {
  return {
    name: "",
    type: "",
    nullable: true,
    autoincrement: false,
    primaryKey: false,
    unique: false,
    defaultMode: "none",
    defaultValue: "",
    comment: "",
  }
}

/**
 * A draft from a described column. The engine prints a default as one
 * string, so whether it was a literal or an expression is a guess: quoted
 * text is a literal, anything else -- `CURRENT_TIMESTAMP`, `nextval(...)`,
 * a bare number -- is left as an expression, which round-trips either way.
 */
export function draftFromInfo(info: ColumnInfo): ColumnDraft {
  let defaultMode: ColumnDraft["defaultMode"] = "none"
  let defaultValue = ""
  if (info.default !== null && !info.autoincrement) {
    const quoted = /^'(.*)'(?:::[\w ]+)?$/s.exec(info.default)
    if (quoted) {
      defaultMode = "literal"
      defaultValue = quoted[1]!.replace(/''/g, "'")
    } else {
      defaultMode = "expression"
      defaultValue = info.default
    }
  }
  return {
    name: info.name,
    type: info.type,
    nullable: info.nullable,
    autoincrement: info.autoincrement,
    primaryKey: info.primary,
    unique: info.unique && !info.primary,
    defaultMode,
    defaultValue,
    comment: info.comment ?? "",
  }
}

/** The draft as the route wants it, or the first thing wrong with it. */
export function specFromDraft(draft: ColumnDraft): { spec: ColumnSpec } | { error: string } {
  const parsed = ColumnSpec.safeParse({
    name: draft.name.trim(),
    type: draft.type.trim(),
    nullable: draft.nullable && !draft.primaryKey,
    autoincrement: draft.autoincrement,
    primaryKey: draft.primaryKey,
    unique: draft.unique,
    default: draft.defaultMode === "none" ? null : { kind: draft.defaultMode, value: draft.defaultValue },
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
  })
  if (parsed.success) return { spec: parsed.data }
  const issue = parsed.error.issues[0]!
  const field = issue.path[0] === "default" ? "default" : String(issue.path[0] ?? "column")
  return { error: `${field}: ${issue.message}` }
}

const TYPE_HINTS: Record<DatabaseEngine, string[]> = {
  mysql: ["INT", "BIGINT", "VARCHAR(255)", "TEXT", "DATETIME", "TIMESTAMP", "DATE", "DECIMAL(10,2)", "TINYINT(1)", "JSON", "BLOB"],
  postgresql: ["integer", "bigint", "serial", "text", "varchar(255)", "boolean", "timestamptz", "date", "numeric(10,2)", "jsonb", "uuid", "bytea"],
}

/**
 * The fields of one column. Controlled, so a create-table dialog can hold
 * a list of these and a modify dialog can hold one; `compact` drops the
 * labels to a single line for the list.
 */
export function ColumnFields({
  draft,
  onChange,
  engine,
  disabled,
  idPrefix,
}: {
  draft: ColumnDraft
  onChange: (next: ColumnDraft) => void
  engine: DatabaseEngine
  disabled?: boolean
  idPrefix: string
}) {
  const set = <K extends keyof ColumnDraft>(key: K, value: ColumnDraft[K]) => onChange({ ...draft, [key]: value })
  const listId = `${idPrefix}-types`

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
          <Input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="created_at"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="font-mono text-sm"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-type`}>Type</FieldLabel>
          <Input
            id={`${idPrefix}-type`}
            value={draft.type}
            onChange={(e) => set("type", e.target.value)}
            placeholder={TYPE_HINTS[engine][0]}
            list={listId}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            className="font-mono text-sm"
          />
          <datalist id={listId}>
            {TYPE_HINTS[engine].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Flag id={`${idPrefix}-pk`} label="Primary key" checked={draft.primaryKey} disabled={disabled} onChange={(v) => set("primaryKey", v)} />
        <Flag
          id={`${idPrefix}-null`}
          label="Nullable"
          checked={draft.nullable && !draft.primaryKey}
          disabled={disabled || draft.primaryKey}
          onChange={(v) => set("nullable", v)}
        />
        <Flag id={`${idPrefix}-ai`} label="Auto increment" checked={draft.autoincrement} disabled={disabled} onChange={(v) => set("autoincrement", v)} />
        <Flag id={`${idPrefix}-uq`} label="Unique" checked={draft.unique} disabled={disabled || draft.primaryKey} onChange={(v) => set("unique", v)} />
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Default</span>
          <select
            aria-label="Default kind"
            value={draft.defaultMode}
            onChange={(e) => set("defaultMode", e.target.value as ColumnDraft["defaultMode"])}
            disabled={disabled}
            className={selectClass}
          >
            <option value="none">None</option>
            <option value="literal">Value</option>
            <option value="expression">Expression</option>
          </select>
        </div>
        <Field className="self-end">
          <Input
            aria-label="Default value"
            value={draft.defaultValue}
            onChange={(e) => set("defaultValue", e.target.value)}
            placeholder={draft.defaultMode === "expression" ? "CURRENT_TIMESTAMP" : draft.defaultMode === "literal" ? "a literal value" : ""}
            disabled={disabled || draft.defaultMode === "none"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={`${idPrefix}-comment`}>Comment</FieldLabel>
        <Input
          id={`${idPrefix}-comment`}
          value={draft.comment}
          onChange={(e) => set("comment", e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      </Field>
    </div>
  )
}

export const selectClass =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-8 rounded-lg border px-2 text-sm outline-none focus-visible:ring-3 disabled:opacity-50 dark:bg-input/30"

export function Flag({
  id,
  label,
  checked,
  disabled,
  onChange,
  className,
}: {
  id: string
  label: React.ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  return (
    <label htmlFor={id} className={cn("flex items-center gap-1.5", disabled && "opacity-60", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-ucch-active size-3.5"
      />
      {label}
    </label>
  )
}

/**
 * Add a column, or change one. The same dialog both ways: `existing` is
 * what the column is now and what the title says, and `after` is offered
 * only when adding, since a changed column stays where it was.
 */
export function ColumnFormDialog({
  open,
  onOpenChange,
  engine,
  existing,
  columns,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  engine: DatabaseEngine
  /** The column being changed; absent when adding. */
  existing?: ColumnInfo
  /** The table's columns, for "place after". */
  columns: ColumnInfo[]
  onSubmit: (spec: ColumnSpec, after: string | undefined) => Promise<void>
}) {
  const [draft, setDraft] = React.useState<ColumnDraft>(emptyColumn)
  const [after, setAfter] = React.useState<string>("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setDraft(existing ? draftFromInfo(existing) : emptyColumn())
    setAfter("")
    setPending(false)
    setError(null)
  }, [open, existing])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const result = specFromDraft(draft)
    if ("error" in result) return setError(result.error)
    setPending(true)
    setError(null)
    try {
      await onSubmit(result.spec, after || undefined)
      onOpenChange(false)
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{existing ? `Change ${existing.name}` : "Add column"}</DialogTitle>
            <DialogDescription>
              {existing
                ? "The column is rewritten with these settings; data is kept where the engine can convert it."
                : "A new column, empty or at its default in every existing row."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <ColumnFields draft={draft} onChange={setDraft} engine={engine} disabled={pending} idPrefix="col" />
            {!existing && engine === "mysql" && columns.length > 0 && (
              <div className="flex flex-col gap-1">
                <label htmlFor="col-after" className="text-sm font-medium">
                  Place after
                </label>
                <select id="col-after" value={after} onChange={(e) => setAfter(e.target.value)} disabled={pending} className={selectClass}>
                  <option value="">At the end</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {existing ? "Save" : "Add column"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
