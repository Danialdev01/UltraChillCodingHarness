"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  DownloadIcon,
  FileTextIcon,
  LibraryBigIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import type { KnowledgeDocumentSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { FileTypeIcon } from "@/components/file-type-icon"
import { KnowledgeBaseDialog } from "@/components/on-demand"
import { KnowledgeGraphView } from "@/components/knowledge/knowledge-graph-view"
import { EmptyState } from "@/components/layout/empty-state"
import { PageContainer, PageHeading } from "@/components/layout/page-container"
import { KnowledgeBaseSkeleton, ListRowsSkeleton } from "@/components/page-skeletons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import {
  anyProcessing,
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  fetchKnowledgeBase,
  fetchKnowledgeDocuments,
  fetchKnowledgeGraph,
  knowledgeDocumentUrl,
  knowledgeKeys,
  rebuildKnowledgeGraph,
  searchKnowledge,
  uploadKnowledgeDocument,
} from "@/lib/knowledge-api"
import { KNOWLEDGE_TABS, knowledgeTabOf, type KnowledgeTab } from "@/lib/knowledge-tabs"
import { useToast } from "@/lib/realtime"
import { sectionHref, sectionById } from "@/lib/sections"
import { formatBytes } from "@/lib/stats-format"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"

/** How often a list with a document still being read asks again. */
const POLL_MS = 2_500

/**
 * One knowledge base: its documents, the graph built from them, and a
 * search over their text -- the same search a chat turn runs, so what is
 * found here is what the agent is shown.
 */
export function KnowledgeBaseView({
  workspaceId,
  baseId,
  canWrite,
  initialTab,
}: {
  workspaceId: string
  baseId: string
  canWrite: boolean
  initialTab: KnowledgeTab
}) {
  const queryClient = useQueryClient()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [tab, setTab] = React.useState<KnowledgeTab>(initialTab)
  const [editing, setEditing] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const base = useQuery({
    queryKey: knowledgeKeys.base(workspaceId, baseId),
    queryFn: () => fetchKnowledgeBase(workspaceId, baseId),
  })
  const documents = useQuery({
    queryKey: knowledgeKeys.documents(workspaceId, baseId),
    queryFn: () => fetchKnowledgeDocuments(workspaceId, baseId),
    refetchInterval: (query) => (anyProcessing(query.state.data) ? POLL_MS : false),
  })

  // A document settling changes the base's figures and its graph.
  const processing = anyProcessing(documents.data)
  const settledCount = documents.data?.filter((d) => d.status !== "processing").length ?? 0
  React.useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.graph(workspaceId, baseId) })
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(workspaceId, baseId) })
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases(workspaceId) })
  }, [settledCount, documents.data?.length, queryClient, workspaceId, baseId])

  const change = (value: unknown) => {
    const next = knowledgeTabOf(typeof value === "string" ? value : undefined)
    setTab(next)
    const url = new URL(window.location.href)
    if (next === "documents") url.searchParams.delete("tab")
    else url.searchParams.set("tab", next)
    window.history.replaceState(window.history.state, "", url)
  }

  if (base.isPending) return <KnowledgeBaseSkeleton />
  if (base.isError) {
    return (
      <PageContainer width="wide">
        <EmptyState
          framed
          icon={LibraryBigIcon}
          title="This knowledge base could not be opened"
          description={base.error.message}
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide">
      <PageHeading
        icon={LibraryBigIcon}
        title={base.data.name}
        description={base.data.description || "No description."}
        meta={
          processing ? (
            <Badge tone="active">
              <Loader2Icon className="size-3 animate-spin" />
              Reading
            </Badge>
          ) : undefined
        }
        actions={
          canWrite && (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon />
                Edit
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon />
                Delete
              </Button>
            </>
          )
        }
      />

      <div className="text-muted-foreground -mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        <span>
          {base.data.documentCount} {base.data.documentCount === 1 ? "document" : "documents"}
        </span>
        <span>{formatBytes(base.data.totalBytes)}</span>
        <span>
          {base.data.entityCount} entities · {base.data.relationCount} relations
        </span>
      </div>

      <Tabs value={tab} onValueChange={change}>
        <TabsList>
          {KNOWLEDGE_TABS.map((t) => (
            <TabsTab key={t.id} value={t.id}>
              {t.label}
            </TabsTab>
          ))}
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="documents">
          <DocumentsTab workspaceId={workspaceId} baseId={baseId} canWrite={canWrite} documents={documents} />
        </TabsPanel>
        <TabsPanel value="graph">
          {tab === "graph" && <GraphTab workspaceId={workspaceId} baseId={baseId} documents={documents.data ?? []} />}
        </TabsPanel>
        <TabsPanel value="search">
          <SearchTab workspaceId={workspaceId} baseId={baseId} />
        </TabsPanel>
      </Tabs>

      <KnowledgeBaseDialog workspaceId={workspaceId} base={base.data} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${base.data.name}?`}
        description="Its documents and graph are deleted with it. Chats that picked it carry on without it."
        typeToConfirm={base.data.name}
        onConfirm={async () => {
          await deleteKnowledgeBase(workspaceId, baseId)
          queryClient.removeQueries({ queryKey: knowledgeKeys.base(workspaceId, baseId) })
          await queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases(workspaceId) })
          router.push(sectionHref(sectionById("knowledge"), ws))
        }}
      />
    </PageContainer>
  )
}

// ---- Documents ---------------------------------------------------------------

function DocumentsTab({
  workspaceId,
  baseId,
  canWrite,
  documents,
}: {
  workspaceId: string
  baseId: string
  canWrite: boolean
  documents: ReturnType<typeof useQuery<KnowledgeDocumentSummary[]>>
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const input = React.useRef<HTMLInputElement>(null)
  // Files on their way, and bytes sent of each: a 2.5 GB document takes a
  // while, so the button shows how far along they are.
  const [uploading, setUploading] = React.useState(0)
  const [progress, setProgress] = React.useState<{ total: number; sent: Record<string, number> }>({ total: 0, sent: {} })
  const [over, setOver] = React.useState(false)
  const [removing, setRemoving] = React.useState<KnowledgeDocumentSummary | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: knowledgeKeys.documents(workspaceId, baseId) })

  const upload = async (files: FileList | File[]) => {
    const list = [...files]
    if (list.length === 0) return
    setUploading((n) => n + list.length)
    const keys = list.map((file, i) => `${Date.now()}:${i}:${file.name}`)
    const total = list.reduce((n, f) => n + f.size, 0)
    setProgress((p) => ({ total: p.total + total, sent: { ...p.sent, ...Object.fromEntries(keys.map((k) => [k, 0])) } }))
    const results = await Promise.allSettled(
      list.map(async (file, i) => {
        try {
          return await uploadKnowledgeDocument(workspaceId, baseId, file, (sent) =>
            setProgress((p) => ({ ...p, sent: { ...p.sent, [keys[i]!]: sent } })),
          )
        } finally {
          setProgress((p) => ({ ...p, sent: { ...p.sent, [keys[i]!]: file.size } }))
          setUploading((n) => {
            if (n - 1 === 0) setProgress({ total: 0, sent: {} })
            return n - 1
          })
        }
      }),
    )
    for (const r of results) {
      if (r.status === "rejected") {
        toast({ title: "Upload failed", description: r.reason instanceof Error ? r.reason.message : undefined, tone: "error" })
      }
    }
    const done = results.filter((r) => r.status === "fulfilled").length
    if (done > 0) toast({ title: done === 1 ? `Added ${list[0]!.name}` : `Added ${done} documents`, description: "Reading it and building its graph." })
    await refresh()
  }

  const dropProps = canWrite
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setOver(false)
          void upload(e.dataTransfer.files)
        },
      }
    : {}

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg", over && "ring-primary ring-2 ring-offset-2")} {...dropProps}>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => input.current?.click()} disabled={uploading > 0}>
            {uploading > 0 ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
            {uploading > 0 ? `Uploading ${uploadPercent(progress)}%` : "Add documents"}
          </Button>
          <span className="text-muted-foreground text-xs">
            Or drop files here. PDF, Word, PowerPoint, spreadsheets, e-books, HTML, Markdown and plain text are read, up to 2.5 GB each.
          </span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(e.target.files)
              e.target.value = ""
            }}
          />
        </div>
      )}

      {documents.isPending ? (
        <div className="rounded-lg border">
          <ListRowsSkeleton rows={5} className="flex flex-col gap-4 p-4" />
        </div>
      ) : documents.isError ? (
        <p className="text-destructive text-sm">{documents.error.message}</p>
      ) : documents.data.length === 0 ? (
        <EmptyState
          framed
          icon={FileTextIcon}
          title="No documents yet"
          description={
            canWrite
              ? "Add the files this base should know. Each is read, split into passages for search, and mined for entities and relations."
              : "Nobody has added a document to this base yet."
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {documents.data.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 px-4 py-3">
              <FileTypeIcon name={doc.name} className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{doc.name}</span>
                  <StatusBadge doc={doc} />
                </div>
                <p className="text-muted-foreground truncate text-xs tabular-nums">
                  {formatBytes(doc.size)}
                  {doc.textLength > 0 && ` · ${doc.textLength.toLocaleString("en-US")} characters`}
                  {doc.status === "ready" && ` · ${doc.entityCount} entities, ${doc.relationCount} relations`}
                  {doc.graphSource === "heuristic" && " · graph without a model"}
                  {doc.error && ` · ${doc.error}`}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring grid size-7 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
                  aria-label={`Actions for ${doc.name}`}
                >
                  <MoreHorizontalIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      window.location.href = knowledgeDocumentUrl(workspaceId, baseId, doc.id)
                    }}
                  >
                    <DownloadIcon />
                    Download
                  </DropdownMenuItem>
                  {canWrite && doc.textLength > 0 && (
                    <DropdownMenuItem
                      onClick={async () => {
                        try {
                          await rebuildKnowledgeGraph(workspaceId, baseId, doc.id)
                          await refresh()
                        } catch (error) {
                          toast({ title: "Could not rebuild", description: error instanceof Error ? error.message : undefined, tone: "error" })
                        }
                      }}
                    >
                      <RefreshCwIcon />
                      Rebuild graph
                    </DropdownMenuItem>
                  )}
                  {canWrite && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(doc)}>
                        <Trash2Icon />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.name ?? "this document"}?`}
        description="Its text leaves the base's search, and what it added to the graph goes with it."
        onConfirm={async () => {
          if (!removing) return
          await deleteKnowledgeDocument(workspaceId, baseId, removing.id)
          await refresh()
        }}
      />
    </div>
  )
}

function StatusBadge({ doc }: { doc: KnowledgeDocumentSummary }) {
  if (doc.status === "processing") {
    return (
      <Badge tone="active">
        <Loader2Icon className="size-3 animate-spin" />
        Reading
      </Badge>
    )
  }
  if (doc.status === "failed") {
    return (
      <Badge tone="danger">
        <AlertCircleIcon className="size-3" />
        Failed
      </Badge>
    )
  }
  if (doc.graphSource === "model") {
    return (
      <Badge tone="success" title="Graph extracted by a model">
        <SparklesIcon className="size-3" />
        Ready
      </Badge>
    )
  }
  return <Badge tone="outline">Ready</Badge>
}

// ---- Graph -------------------------------------------------------------------

function GraphTab({
  workspaceId,
  baseId,
  documents,
}: {
  workspaceId: string
  baseId: string
  documents: readonly KnowledgeDocumentSummary[]
}) {
  const graph = useQuery({
    queryKey: knowledgeKeys.graph(workspaceId, baseId),
    queryFn: () => fetchKnowledgeGraph(workspaceId, baseId),
  })
  if (graph.isPending) return <Skeleton className="h-[min(64vh,640px)] w-full rounded-lg" />
  if (graph.isError) return <p className="text-destructive text-sm">{graph.error.message}</p>
  return <KnowledgeGraphView graph={graph.data} documents={documents} />
}

// ---- Search ------------------------------------------------------------------

function SearchTab({ workspaceId, baseId }: { workspaceId: string; baseId: string }) {
  const [draft, setDraft] = React.useState("")
  const [query, setQuery] = React.useState("")
  const hits = useQuery({
    queryKey: knowledgeKeys.search(workspaceId, baseId, query),
    queryFn: () => searchKnowledge(workspaceId, baseId, query),
    enabled: query !== "",
  })

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask what a chat would ask, e.g. how are refunds handled?"
            className="pl-8"
            aria-label="Search this knowledge base"
          />
        </div>
        <Button type="submit" size="default" disabled={!draft.trim()}>
          {hits.isFetching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
          Search
        </Button>
      </form>
      <p className="text-muted-foreground -mt-2 text-xs">
        The same search a chat runs: the passages found here are the ones the agent is shown first.
      </p>

      {query === "" ? null : hits.isPending ? (
        <div className="rounded-lg border">
          <ListRowsSkeleton rows={4} className="flex flex-col gap-4 p-4" />
        </div>
      ) : hits.isError ? (
        <p className="text-destructive text-sm">{hits.error.message}</p>
      ) : hits.data.length === 0 ? (
        <EmptyState framed icon={SearchIcon} title="Nothing matched" description="No passage shares a word with that. Try the terms the documents themselves use." />
      ) : (
        <ol className="flex flex-col gap-3">
          {hits.data.map((hit, i) => (
            <li key={`${hit.documentId}-${i}`} className="rounded-lg border p-4">
              <div className="text-muted-foreground mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileTypeIcon name={hit.documentName} className="size-3.5 shrink-0" />
                  <span className="truncate">{hit.documentName}</span>
                </span>
                <span className="tabular-nums">score {hit.score}</span>
              </div>
              <p className="line-clamp-6 text-sm whitespace-pre-wrap">{hit.text}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** How far along the uploads in flight are, as a whole percent. */
function uploadPercent(progress: { total: number; sent: Record<string, number> }): number {
  if (progress.total <= 0) return 0
  const sent = Object.values(progress.sent).reduce((n, b) => n + b, 0)
  return Math.min(100, Math.floor((sent / progress.total) * 100))
}
