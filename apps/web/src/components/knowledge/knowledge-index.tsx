"use client"

import * as React from "react"
import { FileTextIcon, LibraryBigIcon, NetworkIcon, PlusIcon } from "lucide-react"
import type { KnowledgeBaseSummary } from "@ucch/protocol"

import { KnowledgeBaseDialog } from "@/components/knowledge/knowledge-base-dialog"
import { EmptyState } from "@/components/layout/empty-state"
import { PageContainer, PageHeading } from "@/components/layout/page-container"
import { KnowledgeCardsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { useKnowledgeBases } from "@/lib/knowledge-api"
import { knowledgeBaseHref, sectionById } from "@/lib/sections"
import { formatBytes } from "@/lib/stats-format"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/** /{ws}/knowledge: every base as a card, and the button that makes one. */
export function KnowledgeIndex({ workspaceId, canWrite }: { workspaceId: string; canWrite: boolean }) {
  const section = sectionById("knowledge")
  const [creating, setCreating] = React.useState(false)

  return (
    <PageContainer width="wide">
      <PageHeading
        icon={section.icon}
        title={section.title}
        description={section.blurb}
        actions={
          canWrite && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              New knowledge base
            </Button>
          )
        }
      />
      <KnowledgeBaseCards workspaceId={workspaceId} canWrite={canWrite} onCreate={() => setCreating(true)} />
      <KnowledgeBaseDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
    </PageContainer>
  )
}

/** The bases as cards, each a link to its page. Shared with the Manage page's tab. */
export function KnowledgeBaseCards({
  workspaceId,
  canWrite,
  onCreate,
}: {
  workspaceId: string
  canWrite: boolean
  onCreate: () => void
}) {
  const bases = useKnowledgeBases(workspaceId)
  const ws = useWorkspaceHash()

  if (bases.isPending) return <KnowledgeCardsSkeleton />
  if (bases.isError) return <p className="text-destructive text-sm">{bases.error.message}</p>
  if (bases.data.length === 0) {
    return (
      <EmptyState
        framed
        icon={LibraryBigIcon}
        title="No knowledge bases yet"
        description="Make one, add documents to it, and pick it in a chat: the agent answers from what the documents say."
        action={
          canWrite && (
            <Button size="sm" onClick={onCreate}>
              <PlusIcon />
              New knowledge base
            </Button>
          )
        }
      />
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {bases.data.map((base) => (
        <KnowledgeBaseCard key={base.id} base={base} href={knowledgeBaseHref(ws, base.id)} />
      ))}
    </div>
  )
}

function KnowledgeBaseCard({ base, href }: { base: KnowledgeBaseSummary; href: string }) {
  return (
    <TransitionLink
      href={href}
      className="hover:bg-muted/50 focus-visible:ring-ring flex min-h-[132px] flex-col gap-1.5 rounded-lg border p-4 outline-none transition-colors focus-visible:ring-2"
    >
      <div className="flex items-center gap-2">
        <LibraryBigIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate text-sm font-medium">{base.name}</span>
      </div>
      <p className="text-muted-foreground line-clamp-2 text-xs">{base.description || "No description."}</p>
      <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs tabular-nums">
        <span className="flex items-center gap-1">
          <FileTextIcon className="size-3.5" aria-hidden />
          {base.documentCount} {base.documentCount === 1 ? "document" : "documents"}
        </span>
        <span className="flex items-center gap-1">
          <NetworkIcon className="size-3.5" aria-hidden />
          {base.entityCount} entities · {base.relationCount} links
        </span>
        <span>{formatBytes(base.totalBytes)}</span>
      </div>
    </TransitionLink>
  )
}
