"use client"

import * as React from "react"
import { CheckIcon, Loader2Icon, SparklesIcon, Undo2Icon } from "lucide-react"

import { MermaidPreview } from "@/components/diagrams/mermaid-preview"
import { PresenceBadge } from "@/components/presence-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DIAGRAM_FILES,
  awaitDiagram,
  diagramJob,
  fetchDiagram,
  generateDiagram,
  saveDiagram,
} from "@/lib/diagrams-api"
import { FileConflictError } from "@/lib/files-api"
import { isOwnChange, othersAt, usePresence, usePresenceLocation, useProjectEvents, useToast } from "@/lib/realtime"
import type { Project } from "@/lib/session"

const PATH = DIAGRAM_FILES.database

/** What an empty diagram starts as: enough to show the syntax. */
const STARTER = `erDiagram
  %% Write the schema here, or use "Update with AI" to draw it from the codebase.
  users {
    uuid id PK
    text email UK
  }
  posts {
    uuid id PK
    uuid author_id FK
    text title
  }
  users ||--o{ posts : writes
`

/** How long typing has to pause before the draft is written to the file. */
const SAVE_AFTER_MS = 800

type SaveState = "saved" | "saving" | "unsaved" | { error: string }

/**
 * The database diagram: its Mermaid source on the left, drawn live on the
 * right, and a bar above both to redraw it from the codebase.
 *
 * The source is `docs/diagrams/database.mmd` in the project's repository,
 * saved a moment after typing stops. "Update with AI" has the server run
 * the account's default model over the checkout; the server saves the
 * result, and it replaces the draft here. The source it replaced is kept
 * for one undo, until the next edit.
 */
export function DatabaseDiagram({ project }: { project: Project }) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [save, setSave] = React.useState<SaveState>("saved")
  const [generating, setGenerating] = React.useState(false)
  const [generateError, setGenerateError] = React.useState<string | null>(null)
  const [beforeAi, setBeforeAi] = React.useState<string | null>(null)
  // What the file holds, as far as this tab knows: a draft equal to it has
  // nothing to save, and a change from elsewhere may replace it.
  const saved = React.useRef<string | null>(null)
  // The version `saved` is, so a save cannot overwrite a write made since.
  // Null while the file does not exist: the first save creates it.
  const version = React.useRef<string | null>(null)
  const toast = useToast()

  const load = React.useCallback(async () => {
    try {
      const file = await fetchDiagram(project.hash, "database")
      saved.current = file?.source ?? STARTER
      version.current = file?.version ?? null
      setDraft(file?.source ?? STARTER)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not open the diagram.")
    }
  }, [project.hash])

  React.useEffect(() => {
    void load()
  }, [load])

  // Saved a beat after the last keystroke. The starter is not written until
  // someone changes it, so opening the tab leaves the repository alone.
  React.useEffect(() => {
    if (draft === null || draft === saved.current) return
    setSave("unsaved")
    const handle = setTimeout(async () => {
      setSave("saving")
      try {
        version.current = await saveDiagram(project.hash, "database", draft, version.current)
        saved.current = draft
        setSave("saved")
      } catch (error) {
        if (error instanceof FileConflictError) {
          // Someone else's write won: show it, and say this edit is gone.
          const source = error.content ?? STARTER
          saved.current = source
          version.current = error.version
          setDraft(source)
          setSave("saved")
          toast({
            tone: "error",
            title: "The diagram was changed elsewhere",
            description: "Your edit was reverted to the latest version.",
          })
          return
        }
        setSave({ error: error instanceof Error ? error.message : "Could not save." })
      }
    }, SAVE_AFTER_MS)
    return () => clearTimeout(handle)
  }, [draft, project.hash, toast])

  // Someone else wrote the file -- another tab, the agent in the chat, a
  // pull. Taken only when there is nothing unsaved here to lose.
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  useProjectEvents(project.id, (event) => {
    if (event.type !== "file.changed" || event.path !== PATH || isOwnChange(event.origin)) return
    // Unsaved typing here is not thrown away: its save will be refused and
    // reverted with a notice instead, so nothing is lost silently.
    if (draftRef.current !== saved.current) return
    void fetchDiagram(project.hash, "database").then(
      (file) => {
        if (!file || draftRef.current !== saved.current) return
        version.current = file.version
        if (file.source === saved.current) return
        saved.current = file.source
        setDraft(file.source)
      },
      () => {},
    )
  })

  const editing = draft !== null && draft !== saved.current
  usePresenceLocation(project.id, `file:${PATH}`, editing)
  const others = othersAt(usePresence(project.id), `file:${PATH}`)

  // Cancels the wait (not the job) when the tab goes away.
  const waiting = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => waiting.current?.abort(), [])

  const follow = React.useCallback(
    async (job: (signal: AbortSignal) => Promise<{ source: string }>, previous: string | null) => {
      const controller = new AbortController()
      waiting.current = controller
      setGenerating(true)
      setGenerateError(null)
      try {
        const result = await job(controller.signal)
        // The server has written it already; its version is read back so
        // the next save here is checked against it.
        saved.current = result.source
        version.current = (await fetchDiagram(project.hash, "database").catch(() => null))?.version ?? null
        setDraft(result.source)
        setSave("saved")
        setBeforeAi(previous)
      } catch (error) {
        if (controller.signal.aborted) return
        setGenerateError(error instanceof Error ? error.message : "Could not generate the diagram.")
      } finally {
        if (!controller.signal.aborted) setGenerating(false)
      }
    },
    [project.hash],
  )

  // A generation started before a reload is still running on the server:
  // pick the spinner back up rather than offer to start a second one.
  React.useEffect(() => {
    let cancelled = false
    diagramJob(project.hash, "database").then(
      (job) => {
        if (!cancelled && job.state === "running") {
          void follow((signal) => awaitDiagram(project.hash, "database", signal), null)
        }
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [project.hash, follow])

  const updateWithAi = () => {
    if (draft === null) return
    void follow((signal) => generateDiagram(project.hash, "database", signal), draft)
  }

  const undoAi = () => {
    if (beforeAi === null) return
    setDraft(beforeAi)
    setBeforeAi(null)
  }

  const edit = (value: string) => {
    setDraft(value)
    setBeforeAi(null)
  }

  if (loadError) return <p className="text-muted-foreground p-8 text-sm">{loadError}</p>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <code className="text-muted-foreground truncate text-xs">{PATH}</code>
        <SaveStatus state={save} />
        <PresenceBadge others={others} />
        <div className="ml-auto flex items-center gap-1">
          {beforeAi !== null && !generating && (
            <Button variant="ghost" size="xs" onClick={undoAi}>
              <Undo2Icon />
              Undo AI update
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={generating || draft === null}
            onClick={updateWithAi}
            title="Read the codebase with your default model and redraw the schema"
          >
            {generating ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {generating ? "Analysing codebase…" : "Update with AI"}
          </Button>
        </div>
      </div>
      {generateError && (
        <p className="text-destructive border-b px-4 py-2 text-xs">{generateError}</p>
      )}
      {draft === null ? (
        <div className="grid flex-1 gap-4 p-4 md:grid-cols-2">
          <Skeleton className="h-full min-h-40" />
          <Skeleton className="h-full min-h-40" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
          <textarea
            value={draft}
            onChange={(event) => edit(event.target.value)}
            spellCheck={false}
            aria-label="Database diagram source"
            readOnly={generating}
            className="bg-muted/20 min-h-0 resize-none border-b p-4 font-mono text-xs leading-relaxed outline-none md:border-r md:border-b-0"
          />
          <MermaidPreview code={draft} className={generating ? "opacity-50" : undefined} />
        </div>
      )}
    </div>
  )
}

function SaveStatus({ state }: { state: SaveState }) {
  if (typeof state === "object") return <span className="text-destructive text-xs">{state.error}</span>
  if (state === "saved") {
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <CheckIcon className="size-3" /> Saved
      </span>
    )
  }
  return <span className="text-muted-foreground text-xs">{state === "saving" ? "Saving…" : "Edited"}</span>
}
