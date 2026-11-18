"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { LibraryBigIcon, PlusIcon } from "lucide-react"

import { KnowledgeBaseDialog } from "@/components/knowledge/knowledge-base-dialog"
import { TreeRowsSkeleton } from "@/components/page-skeletons"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useKnowledgeBases } from "@/lib/knowledge-api"
import { knowledgeBaseHref, knowledgeBaseIdFromPath } from "@/lib/sections"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The Knowledge section's sidebar panel: every base, the open one lit from
 * the URL, and a button that makes a new one.
 */
export function KnowledgePanel({
  workspaceId,
  canWrite,
  compact = false,
  onNavigate,
}: {
  workspaceId: string
  canWrite: boolean
  compact?: boolean
  onNavigate?: () => void
}) {
  const ws = useWorkspaceHash()
  const active = knowledgeBaseIdFromPath(usePathname())
  const bases = useKnowledgeBases(workspaceId)
  const [creating, setCreating] = React.useState(false)

  return (
    <SidebarGroup className="px-0">
      {!compact && (
        <div className="flex items-center justify-between pr-2">
          <SidebarGroupLabel className="px-4">Knowledge bases</SidebarGroupLabel>
          {canWrite && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs outline-none focus-visible:ring-2"
              title="New knowledge base"
            >
              <PlusIcon className="size-3.5" aria-hidden />
              New
            </button>
          )}
        </div>
      )}
      <SidebarGroupContent>
        {bases.isPending ? (
          <div className="px-2">
            <TreeRowsSkeleton rows={3} />
          </div>
        ) : bases.isError ? (
          <p className="text-destructive px-4 py-2 text-xs">{bases.error.message}</p>
        ) : bases.data.length === 0 ? (
          <p className="text-muted-foreground px-4 py-2 text-sm">
            No knowledge bases yet. Make one, add documents, then pick it from a chat&apos;s composer.
          </p>
        ) : (
          <SidebarMenu className="gap-0.5 px-2">
            {bases.data.map((base) => (
              <SidebarMenuItem key={base.id}>
                <SidebarMenuButton
                  size="lg"
                  isActive={base.id === active}
                  onClick={onNavigate}
                  render={<TransitionLink href={knowledgeBaseHref(ws, base.id)} />}
                >
                  <LibraryBigIcon />
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{base.name}</span>
                    <span className="text-muted-foreground truncate text-xs tabular-nums">
                      {base.documentCount} {base.documentCount === 1 ? "document" : "documents"} · {base.entityCount} entities
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
      {!compact && <KnowledgeBaseDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />}
    </SidebarGroup>
  )
}
