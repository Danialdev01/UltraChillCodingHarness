"use client"

import * as React from "react"
import { FileIcon, Loader2Icon, UploadIcon } from "lucide-react"
import type { ExportFormat, ImportResult } from "@ucch/protocol"

import { Flag, selectClass } from "@/components/database/column-form"
import { errorText, useDb } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import { importFile } from "@/lib/database-api"
import { formatBytes } from "@/lib/stats-format"
import { cn } from "@/lib/utils"

/**
 * A file into the database: a SQL script run statement by statement, or a
 * CSV with a header row inserted into one table. The format follows the
 * file's extension unless changed, and the result says exactly how far it
 * got -- for a script that stopped, which statement and why.
 */
export function ImportTab({ table }: { table?: string }) {
  const { ref, db, tables, reloadTables } = useDb()
  const [file, setFile] = React.useState<File | null>(null)
  const [format, setFormat] = React.useState<ExportFormat>("sql")
  const [target, setTarget] = React.useState(table ?? "")
  const [continueOnError, setContinueOnError] = React.useState(false)
  const [emptyAsNull, setEmptyAsNull] = React.useState(true)
  const [pending, setPending] = React.useState(false)
  const [result, setResult] = React.useState<ImportResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)

  function pick(next: File | null) {
    setFile(next)
    setResult(null)
    setError(null)
    if (next && /\.csv$/i.test(next.name)) setFormat("csv")
    else if (next && /\.sql$/i.test(next.name)) setFormat("sql")
  }

  const ready = file !== null && (format === "sql" || target !== "")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!file || !ready) return
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const outcome = await importFile(ref, file, {
        format,
        ...(format === "csv" ? { table: target, emptyAsNull } : { continueOnError }),
      })
      setResult(outcome)
      void reloadTables()
    } catch (caught) {
      setError(errorText(caught, "Could not import the file."))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-medium">Import into {table ?? db}</h2>
        <p className="text-muted-foreground text-xs">A .sql script, or a .csv whose first row names the columns.</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          pick(e.dataTransfer.files[0] ?? null)
        }}
        className={cn(
          "flex max-w-2xl flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm transition-colors",
          dragging && "border-ucch-active bg-ucch-active-bg",
        )}
      >
        <input ref={input} type="file" accept=".sql,.csv,text/csv,application/sql,text/plain" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {file ? (
          <>
            <FileIcon className="text-muted-foreground size-5" />
            <span className="font-mono text-xs">{file.name}</span>
            <span className="text-muted-foreground text-xs">{formatBytes(file.size)}</span>
          </>
        ) : (
          <>
            <UploadIcon className="text-muted-foreground size-5" />
            <span>Drop a file here</span>
          </>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={pending}>
          {file ? "Choose another" : "Choose file"}
        </Button>
      </div>

      <div className="flex max-w-2xl flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} disabled={pending} className={selectClass}>
            <option value="sql">SQL script</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        {format === "csv" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="font-medium">Into table</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending || table !== undefined} className={cn(selectClass, "min-w-40 font-mono text-xs")}>
                <option value="">Choose a table</option>
                {tables.state === "loaded" &&
                  tables.data
                    .filter((t) => t.tableType === "table")
                    .map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
              </select>
            </label>
            <Flag id="import-empty-null" label="Empty cells become NULL" checked={emptyAsNull} disabled={pending} onChange={setEmptyAsNull} className="pb-2" />
          </>
        ) : (
          <Flag id="import-continue" label="Keep going after an error" checked={continueOnError} disabled={pending} onChange={setContinueOnError} className="pb-2" />
        )}
      </div>

      <Button type="submit" disabled={!ready || pending} className="self-start">
        {pending ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
        Import
      </Button>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {result && <Outcome result={result} />}
    </form>
  )
}

function Outcome({ result }: { result: ImportResult }) {
  if (result.format === "csv") {
    return (
      <p role="status" className="max-w-2xl rounded-lg border p-3 text-sm">
        Inserted {result.inserted.toLocaleString()} rows in {result.durationMs} ms.
      </p>
    )
  }
  return (
    <div role="status" className="flex max-w-2xl flex-col gap-2 rounded-lg border p-3 text-sm">
      <p>
        Ran {result.executed.toLocaleString()} of {result.statements.toLocaleString()} statements in {result.durationMs} ms
        {result.failed ? "; one failed." : "."}
      </p>
      {result.failed && (
        <div className="text-xs">
          <p className="text-destructive font-mono whitespace-pre-wrap">{result.failed.error}</p>
          <p className="text-muted-foreground mt-1">
            Statement {result.failed.index + 1}: <code className="font-mono">{result.failed.statement}</code>
          </p>
        </div>
      )}
    </div>
  )
}
