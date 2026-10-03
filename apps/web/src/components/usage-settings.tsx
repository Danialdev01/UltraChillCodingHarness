"use client"

import * as React from "react"
import { CoinsIcon, DatabaseIcon, FolderIcon, HashIcon, SendIcon, type LucideIcon } from "lucide-react"

import { useModels } from "@/components/model-picker"
import { compactNumber, formatBytes, formatUsd } from "@/lib/stats-format"
import { breakdown, modelLabel, type BreakdownRow, type ModelUsage } from "@/lib/usage-breakdown"

/** What the tab is handed by the page. Mirrors the API's shape. */
export interface WorkspaceUsage {
  totals: { costUsd: number; requests: number; tokens: number }
  models: ModelUsage[]
}

/** Disk and database footprint, from the storage endpoint. */
export interface WorkspaceStorage {
  /** This workspace's project directories. */
  files: { bytes: number; projects: { id: string; name: string; bytes: number }[] }
  /** The whole database: its rows are not partitioned by workspace. */
  database: { bytes: number; tables: { name: string; bytes: number }[] }
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
export function UsageSettings({
  usage,
  storage,
}: {
  usage: WorkspaceUsage | null
  storage: WorkspaceStorage | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Spend" hint="What this workspace's agents have cost, by model.">
        <SpendCards usage={usage} />
      </Section>
      <Section title="Storage" hint="What the workspace occupies on disk and in the database.">
        <StorageCards storage={storage} />
      </Section>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      {children}
    </section>
  )
}

function SpendCards({ usage }: { usage: WorkspaceUsage | null }) {
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

/**
 * Two cards: the project directories, and the database.
 *
 * Shown even before any turn has run -- a freshly cloned project takes space
 * the moment it lands, and that is the reader's first question about it.
 * The database card is the whole instance and says so: its rows belong to
 * every workspace at once, and a per-workspace share guessed from row counts
 * would be a number nobody could check against the volume.
 */
function StorageCards({ storage }: { storage: WorkspaceStorage | null }) {
  if (!storage) {
    return (
      <div className="rounded-lg border p-6">
        <p className="text-muted-foreground text-sm">
          Could not load this workspace&apos;s storage.
        </p>
      </div>
    )
  }

  const byBytes = (a: { bytes: number }, b: { bytes: number }) => b.bytes - a.bytes

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SizeCard
        icon={FolderIcon}
        label="Files"
        bytes={storage.files.bytes}
        rows={[...storage.files.projects]
          .sort(byBytes)
          .map((project) => ({ label: project.name, bytes: project.bytes }))}
        empty="No projects in this workspace."
      />

      <SizeCard
        icon={DatabaseIcon}
        label="Database"
        note="Shared by every workspace"
        bytes={storage.database.bytes}
        rows={[...storage.database.tables]
          .sort(byBytes)
          .map((table) => ({ label: table.name, bytes: table.bytes }))}
        empty="No tables."
      />
    </div>
  )
}

/** How many rows a size card names before summing the rest as one line. */
const SIZE_ROWS = 5

function SizeCard({
  icon: Icon,
  label,
  note,
  bytes,
  rows,
  empty,
}: {
  icon: LucideIcon
  label: string
  /** A caveat next to the label, when the figure is not this workspace's alone. */
  note?: string
  bytes: number
  rows: { label: string; bytes: number }[]
  empty: string
}) {
  const shown = rows.slice(0, SIZE_ROWS)
  const rest = rows.slice(SIZE_ROWS)

  return (
    <div className="flex flex-col rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Icon className="size-4" />
        {label}
        {note ? <span className="ml-auto">{note}</span> : null}
      </div>
      <p
        title={`${bytes.toLocaleString("en-US")} bytes`}
        className="mt-2 text-3xl font-semibold tabular-nums"
      >
        {formatBytes(bytes)}
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">{empty}</p>
      ) : (
        <dl className="mt-3 flex flex-col gap-1.5 text-sm">
          {shown.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="truncate" title={row.label}>
                {row.label}
              </dt>
              <dd className="tabular-nums shrink-0" title={`${row.bytes.toLocaleString("en-US")} bytes`}>
                {formatBytes(row.bytes)}
              </dd>
            </div>
          ))}
          {rest.length > 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground truncate">
                {rest.length} other{rest.length === 1 ? "" : "s"}
              </dt>
              <dd className="tabular-nums shrink-0">
                {formatBytes(rest.reduce((sum, row) => sum + row.bytes, 0))}
              </dd>
            </div>
          ) : null}
        </dl>
      )}
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
