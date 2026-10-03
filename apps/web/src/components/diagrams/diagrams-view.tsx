"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { DatabaseIcon, GitForkIcon, NetworkIcon, RouteIcon, type LucideIcon } from "lucide-react"

import { DatabaseDiagram } from "@/components/diagrams/database-diagram"
import { DIAGRAM_KINDS, diagramKindFromParam, type DiagramKindId } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { useTransitionRouter } from "@/lib/view-transitions"

const ICONS: Record<DiagramKindId, LucideIcon> = {
  database: DatabaseIcon,
  architecture: NetworkIcon,
  "system-flow": GitForkIcon,
  "user-flow": RouteIcon,
}

const COMING: Record<Exclude<DiagramKindId, "database">, string> = {
  architecture: "The project's services and how they talk to each other. Arrives later.",
  "system-flow": "How a request moves through the system, step by step. Arrives later.",
  "user-flow": "The paths a person takes through the product. Arrives later.",
}

/**
 * The documentation's Diagrams view: a tab per kind of diagram, the open
 * one on the URL as `?diagram=` so it survives a reload and can be linked.
 */
export function DiagramsView({ project }: { project: Project }) {
  const router = useTransitionRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const kind = diagramKindFromParam(params.get("diagram"))

  const select = (id: DiagramKindId) => {
    const next = new URLSearchParams(params)
    if (id === "database") next.delete("diagram")
    else next.set("diagram", id)
    router.replace(`${pathname}?${next}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b px-4">
        <div
          role="tablist"
          aria-label="Diagram"
          className="bg-muted/40 flex items-center gap-0.5 overflow-x-auto rounded-lg border p-0.5"
        >
          {DIAGRAM_KINDS.map(({ id, label }) => {
            const Icon = ICONS[id]
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                onClick={() => select(id)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                  kind === id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            )
          })}
        </div>
      </div>
      {kind === "database" ? (
        <DatabaseDiagram key={project.hash} project={project} />
      ) : (
        <div className="p-4">
          <div className="rounded-lg border p-6">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              {React.createElement(ICONS[kind], { className: "text-muted-foreground size-4" })}
              {DIAGRAM_KINDS.find((k) => k.id === kind)!.label}
            </h2>
            <p className="text-muted-foreground mt-2 max-w-prose text-sm">{COMING[kind]}</p>
          </div>
        </div>
      )}
    </div>
  )
}
