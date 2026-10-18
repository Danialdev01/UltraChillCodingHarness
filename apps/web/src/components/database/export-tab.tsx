"use client"

import * as React from "react"
import { DownloadIcon } from "lucide-react"
import type { ExportFormat } from "@ucch/protocol"

import { Flag } from "@/components/database/column-form"
import { useDb } from "@/components/database/db-context"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { exportUrl } from "@/lib/database-api"
import { cn } from "@/lib/utils"

/**
 * A dump to download: the whole database or the tables ticked, as SQL, or
 * one table as CSV. The download is a plain link to the export route, so
 * the browser streams it straight to a file rather than through memory.
 */
export function ExportTab({ table }: { table?: string }) {
  const { ref, db, tables } = useDb()
  const [format, setFormat] = React.useState<ExportFormat>("sql")
  const [chosen, setChosen] = React.useState<Set<string> | null>(table ? new Set([table]) : null)
  const [create, setCreate] = React.useState(true)
  const [data, setData] = React.useState(true)
  const [drop, setDrop] = React.useState(false)

  const all = tables.state === "loaded" ? tables.data.map((t) => t.name) : []
  const selected = chosen === null ? all : all.filter((name) => chosen.has(name))
  const everything = chosen === null || (all.length > 0 && selected.length === all.length)
  const csvNeedsOne = format === "csv" && selected.length !== 1
  const ready = selected.length > 0 && !csvNeedsOne && (format === "csv" || create || data)

  const href = ready
    ? exportUrl(ref, {
        format,
        tables: everything && format === "sql" ? undefined : selected,
        ...(format === "sql" ? { create, data, drop: create && drop } : {}),
      })
    : undefined

  /**
   * CSV is one table, so switching to it drops a wider selection rather than
   * drawing four radios all "checked" -- which React would then track as
   * already chosen, and a click on one would change nothing.
   */
  function chooseFormat(next: ExportFormat) {
    setFormat(next)
    if (next === "csv" && selected.length !== 1) setChosen(new Set())
  }

  function toggle(name: string, on: boolean) {
    const next = new Set(chosen ?? all)
    if (on) next.add(name)
    else next.delete(name)
    setChosen(next)
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-medium">Export {table ?? db}</h2>
        <p className="text-muted-foreground text-xs">Downloaded as a file; nothing on the server changes.</p>
      </div>

      <div className="grid max-w-3xl gap-4 md:grid-cols-[14rem_1fr]">
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Format</legend>
            {(["sql", "csv"] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input type="radio" name="format" value={option} checked={format === option} onChange={() => chooseFormat(option)} className="accent-ucch-active" />
                {option === "sql" ? "SQL" : "CSV"}
                <span className="text-muted-foreground text-xs">{option === "sql" ? "structure and rows" : "one table's rows"}</span>
              </label>
            ))}
          </fieldset>

          {format === "sql" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Include</legend>
              <Flag id="export-create" label="CREATE TABLE statements" checked={create} onChange={setCreate} className="text-sm" />
              <Flag id="export-drop" label="DROP TABLE IF EXISTS first" checked={create && drop} disabled={!create} onChange={setDrop} className="text-sm" />
              <Flag id="export-data" label="INSERT statements for every row" checked={data} onChange={setData} className="text-sm" />
            </fieldset>
          )}
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 flex w-full items-center gap-2 text-sm font-medium">
            Tables
            <span className="text-muted-foreground text-xs">
              {selected.length} of {all.length}
            </span>
            {format === "sql" && all.length > 1 && (
              <span className="ml-auto flex gap-2 text-xs font-normal">
                <button type="button" className="underline" onClick={() => setChosen(null)}>
                  All
                </button>
                <button type="button" className="underline" onClick={() => setChosen(new Set())}>
                  None
                </button>
              </span>
            )}
          </legend>
          <div className="max-h-80 overflow-y-auto rounded-lg border p-2">
            {tables.state === "failed" ? (
              <p className="text-muted-foreground p-2 text-xs">{tables.error}</p>
            ) : tables.state !== "loaded" ? (
              <ListRowsSkeleton rows={6} />
            ) : all.length === 0 ? (
              <p className="text-muted-foreground p-2 text-xs">No tables to export.</p>
            ) : (
              <ul className="grid gap-1 sm:grid-cols-2">
                {tables.data.map((t) => (
                  <li key={t.name}>
                    <label className={cn("flex items-center gap-2 rounded px-1.5 py-1 text-sm", format === "csv" && "cursor-pointer")}>
                      <input
                        type={format === "csv" ? "radio" : "checkbox"}
                        name="tables"
                        checked={selected.includes(t.name)}
                        onChange={(e) => (format === "csv" ? setChosen(new Set([t.name])) : toggle(t.name, e.target.checked))}
                        className="accent-ucch-active size-3.5"
                      />
                      <span className="truncate font-mono text-xs">{t.name}</span>
                      {t.tableType === "view" && <span className="text-muted-foreground text-[11px]">view</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {csvNeedsOne && <p className="text-muted-foreground text-xs">A CSV export is one table at a time.</p>}
        </fieldset>
      </div>

      {/* A link once there is something to download, so the browser streams
          it to a file; `nativeButton` tells Base UI the <a> is on purpose. */}
      <Button render={href ? <a href={href} download /> : undefined} nativeButton={!href} disabled={!ready} className="self-start">
        <DownloadIcon />
        Download {format.toUpperCase()}
      </Button>
    </div>
  )
}
