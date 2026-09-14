"use client"

import * as React from "react"
import { CoinsIcon, HashIcon, SendIcon, type LucideIcon } from "lucide-react"

import { useModels } from "@/components/model-picker"
import { compactNumber, formatUsd } from "@/lib/stats-format"
import { breakdown, modelLabel, type BreakdownRow, type ModelUsage } from "@/lib/usage-breakdown"

/** What the tab is handed by the page. Mirrors the API's shape. */
export interface WorkspaceUsage {
  totals: { costUsd: number; requests: number; tokens: number }
  models: ModelUsage[]
}

/**
 * What this workspace has spent, and on which models.
 *
 * Three cards over the same rows: one bill read three ways, because the
 * question "why is this expensive" is answered by spend, the question "what
 * is the agent doing" by request count, and the two rarely point at the same
 * model. Every card ranks the models itself for that reason.
 *
 * Model names come from the live catalogue, so a model the provider has
 * since retired still shows the id it was billed under rather than
 * disappearing from the breakdown.
 */
export function UsageSettings({ usage }: { usage: WorkspaceUsage | null }) {
  const { models: catalogue } = useModels()

  const names = React.useMemo(
    () => new Map(catalogue.map((model) => [model.id, model.name])),
    [catalogue],
  )

  if (!usage) {
    return (
      <div className="rounded-lg border p-6">
        <p className="text-muted-foreground text-sm">
          Could not load this workspace&apos;s usage.
        </p>
      </div>
    )
  }

  if (usage.totals.requests === 0) {
    return (
      <div className="rounded-lg border p-6">
        <p className="text-sm">No usage yet.</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Figures appear here once an agent has run a turn in this workspace.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <UsageCard
        icon={CoinsIcon}
        label="Spend"
        value={formatUsd(usage.totals.costUsd)}
        rows={breakdown(usage.models, (model) => model.costUsd)}
        names={names}
        format={formatUsd}
      />

      <UsageCard
        icon={SendIcon}
        label="Requests"
        value={usage.totals.requests.toLocaleString("en-US")}
        rows={breakdown(usage.models, (model) => model.requests)}
        names={names}
        format={(value) => value.toLocaleString("en-US")}
      />

      <UsageCard
        icon={HashIcon}
        label="Tokens"
        value={compactNumber(usage.totals.tokens)}
        title={`${Math.round(usage.totals.tokens).toLocaleString("en-US")} tokens`}
        rows={breakdown(usage.models, (model) => model.tokens)}
        names={names}
        format={compactNumber}
        // The exact figure for a row, which the compact form has rounded off.
        rowTitle={(value) => `${Math.round(value).toLocaleString("en-US")} tokens`}
      />
    </div>
  )
}

function UsageCard({
  icon: Icon,
  label,
  value,
  title,
  rows,
  names,
  format,
  rowTitle,
}: {
  icon: LucideIcon
  label: string
  value: string
  /** The unrounded headline, for the reader who wants it. */
  title?: string
  rows: BreakdownRow[]
  names: ReadonlyMap<string, string>
  format: (value: number) => string
  rowTitle?: (value: number) => string
}) {
  return (
    <div className="flex flex-col rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Icon className="size-4" />
        {label}
      </div>
      <p title={title} className="mt-2 text-3xl font-semibold tabular-nums">
        {value}
      </p>

      <dl className="mt-3 flex flex-col gap-1.5 text-sm">
        {rows.map((row, index) => (
          <div
            // Two rows can share a null model -- the unknown bucket and the
            // remainder -- so the position is part of what identifies one.
            key={`${row.model ?? "none"}:${index}`}
            className="flex items-baseline justify-between gap-3"
          >
            <dt
              className={`truncate ${row.others || !row.model ? "text-muted-foreground" : ""}`}
              title={row.model ?? undefined}
            >
              {modelLabel(row.model, names, row.others)}
            </dt>
            <dd
              className="tabular-nums shrink-0"
              {...(rowTitle ? { title: rowTitle(row.value) } : {})}
            >
              {format(row.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
