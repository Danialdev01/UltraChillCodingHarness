"use client"

import * as React from "react"
import { Loader2Icon, PlayIcon } from "lucide-react"
import type { StatementResult } from "@ucch/protocol"

import { Flag, selectClass } from "@/components/database/column-form"
import { errorText, useDb } from "@/components/database/db-context"
import { ResultsTable } from "@/components/database/results-table"
import { SqlEditor } from "@/components/database/sql-editor"
import { Button } from "@/components/ui/button"
import { runSql } from "@/lib/database-api"
import { cn } from "@/lib/utils"

const LIMITS = [100, 1000, 5000] as const

/**
 * A SQL console on the open database. Whatever is typed runs as the
 * connection's user, statement by statement, and each statement's result
 * is shown under it -- rows, a count, or the engine's error.
 *
 * Anything that changes the schema is reflected in the tables column by
 * re-reading the list afterwards; cheaper than parsing SQL to find out
 * whether it did.
 */
export function SqlTab({ initial = "" }: { initial?: string }) {
  const { ref, engine, reloadTables } = useDb()
  const text = React.useRef(initial)
  const [maxRows, setMaxRows] = React.useState<number>(1000)
  const [continueOnError, setContinueOnError] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [results, setResults] = React.useState<StatementResult[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = React.useCallback(async () => {
    const sql = text.current.trim()
    if (!sql || running) return
    setRunning(true)
    setError(null)
    try {
      setResults(await runSql(ref, sql, { maxRows, continueOnError }))
      void reloadTables()
    } catch (caught) {
      setError(errorText(caught, "Could not run the SQL."))
    } finally {
      setRunning(false)
    }
  }, [ref, maxRows, continueOnError, running, reloadTables])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b">
        <SqlEditor
          initial={initial}
          engine={engine}
          onChange={(next) => {
            text.current = next
          }}
          onRun={() => void run()}
          className="max-h-[40svh] min-h-32 overflow-auto"
        />
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
          <Button size="sm" onClick={() => void run()} disabled={running}>
            {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            Run
            <kbd className="text-primary-foreground/70 ml-1 font-sans text-[10px]">⌘⏎</kbd>
          </Button>
          <label className="text-muted-foreground flex items-center gap-1.5">
            Up to
            <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))} className={cn(selectClass, "h-7 text-xs")}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
            rows per query
          </label>
          <Flag id="sql-continue" label="Keep going after an error" checked={continueOnError} onChange={setContinueOnError} className="text-muted-foreground" />
          {results && !running && (
            <span className="text-muted-foreground ml-auto tabular-nums">
              {results.length} statement{results.length === 1 ? "" : "s"} · {results.reduce((s, r) => s + r.durationMs, 0)} ms
            </span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {results === null && !error && (
          <p className="text-muted-foreground text-sm">Results appear here. Several statements can be run at once, separated by semicolons.</p>
        )}
        {results?.map((result, i) => <ResultsTable key={i} result={result} index={i} />)}
      </div>
    </div>
  )
}
