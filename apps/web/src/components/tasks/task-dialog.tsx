"use client"

import * as React from "react"
import {
  FileIcon,
  FolderIcon,
  LightbulbIcon,
  LinkIcon,
  ListTodoIcon,
  Loader2Icon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import {
  TASK_DESCRIPTION_MAX,
  TASK_REFERENCES_MAX,
  TASK_TITLE_MAX,
  type ProjectTask,
  type TaskReference,
} from "@ucch/protocol"

import {
  FIELD,
  FormDialog,
  FormDialogFooter,
  FormField,
  Optional,
  PopoverSelect,
  SECONDARY_BUTTON,
  TEXTAREA,
} from "@/components/form-dialog"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { fetchTree, type FileNode } from "@/lib/files-api"
import type { Project } from "@/lib/session"
import type { TaskInput } from "@/lib/tasks-api"
import { stageUpload } from "@/lib/uploads-api"
import { cn } from "@/lib/utils"

/** What the dialog is open for: a new todo, or one already on the board. */
export type TaskDialogState = { mode: "create" } | { mode: "edit"; task: ProjectTask } | null

/**
 * The form behind a card: what to do, which project it is for, more about it,
 * and what to look at -- links, files of that project, or files attached from
 * this computer.
 *
 * `projectHash` is the project picked when the dialog opens: the board's own
 * project there, nothing from the sidebar. A todo cannot move between
 * projects, so editing one keeps the select locked.
 */
export function TaskDialog({
  state,
  projects,
  projectHash,
  busy,
  onClose,
  onSave,
}: {
  state: TaskDialogState
  projects: readonly Project[]
  projectHash?: string
  busy: boolean
  onClose: () => void
  onSave: (input: TaskInput, projectHash: string) => Promise<void>
}) {
  const editing = state?.mode === "edit" ? state.task : null

  const [target, setTarget] = React.useState("")

  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [references, setReferences] = React.useState<TaskReference[]>([])
  const [url, setUrl] = React.useState("")
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!state) return
    setTarget(projectHash ?? "")
    setTitle(editing?.title ?? "")
    setDescription(editing?.description ?? "")
    setReferences(editing?.references ?? [])
    setUrl("")
    setError(null)
  }, [state, editing, projectHash])

  /** Project files and uploads belong to the project they came from. */
  function choose(hash: string) {
    setTarget(hash)
    setReferences((current) => current.filter((r) => r.kind === "url"))
  }

  const full = references.length >= TASK_REFERENCES_MAX

  function add(ref: TaskReference) {
    setReferences((current) => {
      const key = referenceKey(ref)
      if (current.some((r) => referenceKey(r) === key)) return current
      return [...current, ref].slice(0, TASK_REFERENCES_MAX)
    })
  }

  function addUrl() {
    const value = url.trim()
    if (!value) return
    try {
      const parsed = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error()
      add({ kind: "url", url: parsed.toString() })
      setUrl("")
      setError(null)
    } catch {
      setError("That does not look like a web address.")
    }
  }

  async function attach(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        const staged = await stageUpload(target, file)
        add({ kind: "upload", uploadId: staged.id, name: staged.name })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const name = title.trim()
    if (!name) return setError("Say what the task is.")
    if (!target) return setError("Choose the project this todo is for.")
    setError(null)
    try {
      await onSave({ title: name, description: description.trim(), references }, target)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const projectOptions = React.useMemo(
    () => projects.map((project) => ({ value: project.hash, label: project.name })),
    [projects],
  )

  return (
    <FormDialog
      open={state !== null}
      onOpenChange={(open) => !open && onClose()}
      busy={busy}
      icon={editing ? PencilIcon : ListTodoIcon}
      title={editing ? "Edit todo" : "New todo"}
      description={
        editing
          ? "Change what the AI is working from."
          : "Lands in Idea. Move it to Research, or let Auto Run do it, and the AI takes it from there."
      }
      onSubmit={submit}
      footer={
        <FormDialogFooter
          hint={editing ? undefined : "Lands in Idea"}
          hintIcon={editing ? undefined : LightbulbIcon}
          busy={busy}
          disabled={uploading}
        >
          {editing ? "Save" : "Add todo"}
        </FormDialogFooter>
      }
    >
      <FormField label="Task" htmlFor="todo-title">
        <input
          id="todo-title"
          autoFocus
          value={title}
          maxLength={TASK_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What has to be done"
          autoComplete="off"
          className={FIELD}
        />
      </FormField>

      <FormField
        label="Project"
        labelId="todo-project-label"
        helper={editing ? "A todo stays with the project it was made for." : undefined}
      >
        <PopoverSelect
          value={target}
          options={projectOptions}
          onChange={choose}
          icon={FolderIcon}
          placeholder="Choose a project"
          heading="Projects"
          searchable={projects.length > 6}
          emptyText="No project matches that."
          disabled={Boolean(editing)}
          labelledBy="todo-project-label"
        />
      </FormField>

      <FormField label={<>Description<Optional /></>} htmlFor="todo-description">
        <textarea
          id="todo-description"
          value={description}
          maxLength={TASK_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Details, constraints, what done looks like"
          className={TEXTAREA}
        />
      </FormField>

      <div role="separator" className="h-px bg-(--fd-border-subtle)" />

      <FormField
        label="References"
        htmlFor="todo-url"
        aside={
          <span className="text-[11px] text-(--fd-text-faint)">
            {references.length}/{TASK_REFERENCES_MAX}
          </span>
        }
      >
        <div className="flex gap-1.5">
          <input
            id="todo-url"
            value={url}
            disabled={full}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addUrl()
              }
            }}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
            className={cn(FIELD, "fd-mono text-[12px]")}
          />
          <button
            type="button"
            disabled={full || !url.trim()}
            onClick={addUrl}
            className={cn(SECONDARY_BUTTON, "h-[34px]")}
          >
            <LinkIcon /> Add URL
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ProjectFilePicker
            key={target}
            projectHash={target}
            disabled={full || !target}
            onPick={(path) => add({ kind: "file", path })}
          />
          <button
            type="button"
            disabled={full || uploading || !target}
            onClick={() => fileInput.current?.click()}
            className={SECONDARY_BUTTON}
          >
            {uploading ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
            Attach file
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => void attach(e.target.files)}
          />
        </div>
        {references.length > 0 && (
          <ul className="grid gap-1">
            {references.map((ref) => (
              <li
                key={referenceKey(ref)}
                className="flex items-center gap-2 rounded-[8px] border border-(--fd-border-subtle) bg-(--fd-field-muted) px-2.5 py-1.5 text-[12px] text-(--fd-text-label)"
              >
                <ReferenceIcon reference={ref} />
                <span className="min-w-0 flex-1 truncate">{referenceLabel(ref)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${referenceLabel(ref)}`}
                  className="grid size-5 shrink-0 place-items-center rounded-[5px] text-(--fd-text-muted) transition-colors hover:bg-(--fd-hover) hover:text-(--fd-text)"
                  onClick={() =>
                    setReferences((current) => current.filter((r) => referenceKey(r) !== referenceKey(ref)))
                  }
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </FormField>

      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </FormDialog>
  )
}

/** A searchable list of the project's files, loaded when first opened. */
function ProjectFilePicker({
  projectHash,
  disabled,
  onPick,
}: {
  projectHash: string
  disabled: boolean
  onPick: (path: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [paths, setPaths] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || paths) return
    fetchTree(projectHash).then(
      ({ tree }) => setPaths(flatten(tree)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }, [open, paths, projectHash])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" disabled={disabled} className={SECONDARY_BUTTON} />}>
        <PlusIcon /> Project file
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search files…" />
          <CommandList>
            {paths || error ? (
              <CommandEmpty>{error ?? "No file matches."}</CommandEmpty>
            ) : (
              <ListRowsSkeleton rows={6} />
            )}
            {paths && paths.length > 0 && (
              <CommandGroup>
                {paths.slice(0, 2000).map((path) => (
                  <CommandItem
                    key={path}
                    value={path}
                    onSelect={() => {
                      onPick(path)
                      setOpen(false)
                    }}
                  >
                    <FileIcon />
                    <span className="truncate">{path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Every file in the tree as a path from the project root; folders are left out. */
function flatten(nodes: readonly FileNode[], prefix = ""): string[] {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name
    return node.children ? flatten(node.children, path) : [path]
  })
}

export function referenceKey(ref: TaskReference): string {
  switch (ref.kind) {
    case "url":
      return `url:${ref.url}`
    case "file":
      return `file:${ref.path}`
    case "upload":
      return `upload:${ref.uploadId}`
  }
}

export function referenceLabel(ref: TaskReference): string {
  switch (ref.kind) {
    case "url":
      return ref.url
    case "file":
      return ref.path
    case "upload":
      return ref.name
  }
}

export function ReferenceIcon({ reference }: { reference: TaskReference }) {
  const Icon = reference.kind === "url" ? LinkIcon : reference.kind === "file" ? FileIcon : PaperclipIcon
  return <Icon className="text-muted-foreground size-4 shrink-0" />
}
