"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { CheckIcon, Loader2Icon, SparklesIcon, Undo2Icon } from "lucide-react"

import { MermaidPreview } from "@/components/diagrams/mermaid-preview"
import { PresenceBadge } from "@/components/presence-badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FILE_FIELD, fileDocumentName, useCollabDocument, useCollabUser } from "@/lib/collab"
import {
  DIAGRAM_FILES,
  awaitDiagram,
  type BuiltDiagramKind,
  diagramJob,
  fetchDiagram,
  generateDiagram,
  saveDiagram,
} from "@/lib/diagrams-api"
import { replacement } from "@/lib/doc-sync"
import { FileConflictError } from "@/lib/files-api"
import {
  isOwnChange,
  othersAt,
  useLiveResource,
  usePresence,
  usePresenceLocation,
  useProjectEvents,
  useToast,
} from "@/lib/realtime"
import type { Project } from "@/lib/session"

/** The project's code editor, fetched when a diagram first opens; see `code-editor.tsx`. */
const VimEditor = dynamic(() => import("@/components/vim-editor").then((m) => m.VimEditor), {
  ssr: false,
  loading: () => <Skeleton className="m-4 min-h-40 flex-1" />,
})

/**
 * What each diagram is called, what "Update with AI" redraws, and what an
 * empty one starts as: enough to show the syntax.
 */
const KINDS: Record<BuiltDiagramKind, { name: string; redraws: string; starter: string }> = {
  database: {
    name: "Database",
    redraws: "the schema",
    starter: `erDiagram
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
`,
  },
  architecture: {
    name: "Architecture",
    redraws: "the services and how they talk",
    starter: `flowchart LR
  %% Write the architecture here, or use "Update with AI" to draw it from the codebase.
  web[Web app] -->|HTTP| api[API server]
  api -->|SQL| db[(Database)]
`,
  },
  "system-flow": {
    name: "System flow",
    redraws: "the main request's path through the system",
    starter: `sequenceDiagram
  %% Write the system flow here, or use "Update with AI" to draw it from the codebase.
  participant Client
  participant Server
  participant Database
  Client->>Server: request
  Server->>Database: query
  Database-->>Server: rows
  Server-->>Client: response
`,
  },
  "user-flow": {
    name: "User flow",
    redraws: "the paths a person takes through the product",
    starter: `flowchart TD
  %% Write the user flow here, or use "Update with AI" to draw it from the codebase.
  landing[Landing page] --> signin{Signed in?}
  signin -->|no| login[Sign in]
  signin -->|yes| dashboard[Dashboard]
  login --> dashboard
`,
  },
}

/** How long typing has to pause before the draft is written to the file. */
const SAVE_AFTER_MS = 800

type SaveState = "saved" | "saving" | "unsaved" | { error: string }

/**
 * One diagram: drawn live in the middle, its Mermaid source in a column on
 * the right (below it on a narrow screen), and a bar above both to redraw
 * it from the codebase.
 *
 * The source is the kind's file in `.ucch/diagrams/` in the project's
 * repository. Once the file exists it is shared live, like any open file
 * (`code-editor.tsx`): everyone with it open types into one document, which
 * the collab service writes back. Before that -- or without the service --
 * it is saved a moment after typing stops. "Update with AI" has the
 * server run the account's default model over the checkout; the server
 * saves the result, and it replaces the draft here. The source it replaced
 * is kept for one undo, until the next edit.
 *
 * Mount one per kind (keyed on it): the refs below belong to one file.
 */
export function DiagramEditor({ project, kind }: { project: Project; kind: BuiltDiagramKind }) {
  const PATH = DIAGRAM_FILES[kind]
  const { name, redraws, starter: STARTER } = KINDS[kind]
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
  // Only a file on disk has a shared document: the starter is not one yet.
  const [exists, setExists] = React.useState(false)
  const toast = useToast()

  const collab = useCollabDocument(exists ? fileDocumentName(project.id, null, PATH) : null, {
    fresh: true,
    giveUpAfterMs: 5000,
  })
  const shown = collab.shown
  const liveRef = React.useRef(false)
  liveRef.current = shown !== null
  const user = useCollabUser()
  React.useEffect(() => {
    shown?.provider.setAwarenessField("user", user)
  }, [shown?.provider, user])

  // Live, the draft is the document's text: whoever typed it, or the agent's
  // rewrite reread from disk. It is on disk, or about to be, so never unsaved.
  const provider = shown?.provider
  React.useEffect(() => {
    if (!provider) return
    const ytext = provider.document.getText(FILE_FIELD)
    const take = () => {
      const text = ytext.toString()
      saved.current = text
      setDraft(text)
      setSave("saved")
    }
    take()
    ytext.observe(take)
    return () => ytext.unobserve(take)
  }, [provider])

  const load = React.useCallback(async () => {
    try {
      const file = await fetchDiagram(project.hash, kind)
      saved.current = file?.source ?? STARTER
      version.current = file?.version ?? null
      setExists(file !== null)
      setDraft(file?.source ?? STARTER)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not open the diagram.")
    }
  }, [project.hash, kind])

  React.useEffect(() => {
    void load()
  }, [load])

  // Saved a beat after the last keystroke. The starter is not written until
  // someone changes it, so opening the tab leaves the repository alone.
  // Ctrl-S and `:w` in the editor: the pending save, now rather than after the pause.
  const saveNow = React.useRef<() => void>(() => {})
  React.useEffect(() => {
    if (draft === null || draft === saved.current || liveRef.current) return
    setSave("unsaved")
    const run = async () => {
      setSave("saving")
      try {
        version.current = await saveDiagram(project.hash, kind, draft, version.current)
        saved.current = draft
        setSave("saved")
        setExists(true)
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
    }
    const handle = setTimeout(run, SAVE_AFTER_MS)
    saveNow.current = () => {
      clearTimeout(handle)
      saveNow.current = () => {}
      void run()
    }
    return () => {
      clearTimeout(handle)
      saveNow.current = () => {}
    }
  }, [draft, project.hash, kind, toast])

  // Someone else wrote the file -- another tab, the agent in the chat, a
  // pull. Taken only when there is nothing unsaved here to lose.
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  // With files: the diagram's source is a file in the project, which a
  // terminal or a pull can change as well as the agent.
  useProjectEvents(
    project.id,
    (event) => {
      if (event.type !== "file.changed" || event.path !== PATH || isOwnChange(event.origin)) return
      // Live, the document brings the change itself.
      if (liveRef.current) return
      // Unsaved typing here is not thrown away: its save will be refused and
      // reverted with a notice instead, so nothing is lost silently.
      if (draftRef.current !== saved.current) return
      void fetchDiagram(project.hash, kind).then(
        (file) => {
          if (!file || draftRef.current !== saved.current) return
          version.current = file.version
          if (file.source === saved.current) return
          saved.current = file.source
          setDraft(file.source)
        },
        () => {},
      )
    },
    { files: true },
  )

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
        // the next save here is checked against it. Live, the document
        // rereads it from disk and brings it to every editor.
        if (!liveRef.current) {
          saved.current = result.source
          version.current = (await fetchDiagram(project.hash, kind).catch(() => null))?.version ?? null
          setDraft(result.source)
          setSave("saved")
        }
        setExists(true)
        setBeforeAi(previous)
      } catch (error) {
        if (controller.signal.aborted) return
        setGenerateError(error instanceof Error ? error.message : "Could not generate the diagram.")
      } finally {
        if (!controller.signal.aborted) setGenerating(false)
        if (waiting.current === controller) waiting.current = null
      }
    },
    [project.hash, kind],
  )

  // A generation started before a reload is still running on the server:
  // pick the spinner back up rather than offer to start a second one.
  React.useEffect(() => {
    let cancelled = false
    diagramJob(project.hash, kind).then(
      (job) => {
        if (!cancelled && job.state === "running") {
          void follow((signal) => awaitDiagram(project.hash, kind, signal), null)
        }
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [project.hash, kind, follow])

  // Started (or finished) from another tab or by someone else: follow it here too.
  useLiveResource(
    "diagrams",
    (event) => {
      if (event.id !== kind || waiting.current) return
      void diagramJob(project.hash, kind).then(
        (job) => {
          if (job.state === "running") void follow((signal) => awaitDiagram(project.hash, kind, signal), null)
        },
        () => {},
      )
    },
    project.id,
  )

  const updateWithAi = () => {
    if (draft === null) return
    void follow((signal) => generateDiagram(project.hash, kind, signal), draft)
  }

  const undoAi = () => {
    if (beforeAi === null) return
    if (shown) {
      // Into the document, as one edit, so everyone's cursor stays put.
      const document = shown.provider.document
      const ytext = document.getText(FILE_FIELD)
      const change = replacement(ytext.toString(), beforeAi)
      if (change) {
        document.transact(() => {
          if (change.to > change.from) ytext.delete(change.from, change.to - change.from)
          if (change.insert) ytext.insert(change.from, change.insert)
        })
      }
    } else {
      setDraft(beforeAi)
    }
    setBeforeAi(null)
  }

  const edit = (value: string) => {
    // The editor echoes text pushed into it (an AI result, a reload) as a
    // change; only a real edit drops the undo.
    if (value === draftRef.current) return
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
            title={`Read the codebase with your default model and redraw ${redraws}`}
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
        <div className="grid flex-1 gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,32%)]">
          <Skeleton className="h-full min-h-40" />
          <Skeleton className="h-full min-h-40" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-[minmax(0,1fr)_minmax(18rem,32%)] md:grid-rows-1">
          <MermaidPreview code={draft} className={generating ? "opacity-50" : undefined} />
          <section aria-label={`${name} diagram source`} className="flex min-h-0 flex-col border-t md:border-t-0 md:border-l">
            <VimEditor
              // A new instance when a shared copy is bound: the text is then the document's.
              key={shown ? shown.generation : "own"}
              path={PATH}
              initialText={draft}
              text={draft}
              onChange={edit}
              onSave={() => saveNow.current()}
              autoFocus={false}
              collab={
                shown
                  ? { ytext: shown.provider.document.getText(FILE_FIELD), awareness: shown.provider.awareness }
                  : undefined
              }
              // Waiting for the shared copy, out of touch with it, or a viewer:
              // shown, not changed (see `LiveFile` in code-editor.tsx).
              readOnly={
                generating ||
                (shown ? !shown.connected || shown.readOnly : exists && !collab.failed)
              }
            />
          </section>
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
