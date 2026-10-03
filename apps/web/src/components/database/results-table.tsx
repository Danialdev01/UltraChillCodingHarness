"use client"

import { AlertCircleIcon, CheckIcon } from "lucide-react"
import type { StatementResult } from "@ucch/protocol"

import { CellValue } from "@/components/database/cell-value"
import { cn } from "@/lib/utils"

/**
 * What one statement came back with: a grid for a query, a line for
 * anything else, the engine's own words for an error.
 */
export function ResultsTable({ result, index }: { result: StatementResult; index: number }) {
  const ms = `${result.durationMs} ms`
  return (
    <section className="rounded-lg border">
      <header className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground shrink-0 tabular-nums">#{index + 1}</span>
        <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono" title={result.statement}>
          {result.statement}
        </code>
        {result.error ? (
          <span className="text-destructive flex shrink-0 items-center gap-1">
            <AlertCircleIcon className="size-3.5" /> failed
          </span>
        ) : (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1">
            <CheckIcon className="size-3.5" />
            {result.rows ? `${result.rows.length}${result.truncated ? "+" : ""} rows` : result.affectedRows !== undefined ? `${result.affectedRows} affected` : result.command ?? "ok"}
            {result.insertId !== undefined && ` · id ${result.insertId}`}
            {" · "}
            {ms}
          </span>
        )}
      </header>
      {result.error ? (
        <p role="alert" className="text-destructive px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {result.error}
        </p>
      ) : result.columns && result.rows ? (
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
            <thead className="bg-background sticky top-0">
              <tr>
                {result.columns.map((column, i) => (
                  <th key={`${column}-${i}`} className="border-b px-2 py-1.5 text-left font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="hover:bg-muted/40">
                  {row.map((cell, c) => (
                    <td key={c} className={cn("max-w-md border-b px-2 py-1 whitespace-nowrap", r === result.rows!.length - 1 && "border-b-0")}>
                      <CellValue cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.truncated && <p className="text-muted-foreground border-t px-3 py-1.5 text-xs">Cut at {result.rows.length} rows; raise the limit to see more.</p>}
        </div>
      ) : null}
    </section>
  )
}
