"use client"

import * as React from "react"
import { CylinderIcon, DownloadIcon, ExternalLinkIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { DATABASE_ENGINE_LABELS, type DatabaseConnectionSummary, type DatabaseSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { CreateDatabaseDialog } from "@/components/database/create-database-dialog"
import { DbProvider, errorText, type Listing } from "@/components/database/db-context"
import { ImportTab } from "@/components/database/import-tab"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { announceDatabasesChanged, dropDatabase, exportUrl, fetchDatabaseDetails } from "@/lib/database-api"
import { databaseHref } from "@/lib/sections"
import { useActiveWorkspace, useWorkspaceHash } from "@/lib/workspace-context"
import { useBootstrap } from "@/lib/queries/bootstrap"
import { formatBytes } from "@/lib/stats-format"
import { TransitionLink } from "@/lib/view-transitions"
import { useCachedState } from "@/lib/queries/cached-state"
import { qk } from "@/lib/query-keys"

/**
 * A connection's own page: every database on the server, and what can be
 * done to one from outside it -- open it, back it up, import into it,
 * drop it, or make another. What phpMyAdmin shows when you click the
 * server rather than a database.
 */
export function ConnectionHome({ connection: rendered }: { connection: DatabaseConnectionSummary }) {
  const ws = useWorkspaceHash()
  // The shell's copy once it has one: an edit in the settings dialog
  // invalidates bootstrap, and the page shows the new name and address.
  const live = useBootstrap(useActiveWorkspace()?.hash ?? null).data?.connections.find((c) => c.id === rendered.id)
  const connection = live ?? rendered
  // Cached: the server's databases show at once on a return visit.
  const [listed, , reload, listState] = useCachedState(
    qk.database.databases(connection.id),
    () => fetchDatabaseDetails(connection.id),
    { persist: true },
  )
  const databases = React.useMemo<Listing<DatabaseSummary[]>>(
    () =>
      listed
        ? { state: "loaded", data: listed }
        : listState.error
          ? { state: "failed", error: errorText(listState.error, "Could not list the databases.") }
          : { state: "loading" },
    [listed, listState.error],
  )
  const [creating, setCreating] = React.useState(false)
  const [importing, setImporting] = React.useState<string | null>(null)
  const [dropping, setDropping] = React.useState<DatabaseSummary | null>(null)

  const load = reload

  /** The sidebar lists the same databases; tell it. */
  async function changed() {
    await load()
    announceDatabasesChanged(connection.id)
  }

  const total = databases.state === "loaded" ? databases.data.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0) : null

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3 rounded-lg border p-4">
        <ServerIcon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{connection.name}</h2>
          <p className="text-muted-foreground font-mono text-xs">
            {DATABASE_ENGINE_LABELS[connection.engine]} · {connection.username}@{connection.host}:{connection.port}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} title="Refresh">
            <RefreshCwIcon />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImporting("")} disabled={databases.state !== "loaded"}>
            <UploadIcon />
            Import
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            New database
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Databases</h3>
        {databases.state === "loaded" && (
          <span className="text-muted-foreground text-xs">
            {databases.data.length}
            {total !== null && total > 0 && ` · ${formatBytes(total)}`}
          </span>
        )}
      </div>

      {databases.state === "loading" ? (
        <div className="rounded-lg border">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
              <Skeleton className="h-3" style={{ width: `${20 + ((i * 17) % 30)}%` }} />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      ) : databases.state === "failed" ? (
        <div>
          <p role="alert" className="text-destructive text-sm">
            {databases.error}
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : databases.data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border p-6 text-center text-sm">No databases visible to this user.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Database</TableHead>
                <TableHead className="text-right">Tables</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {databases.data.map((db) => {
                const href = databaseHref(ws, connection.id, db.name)
                return (
                  <TableRow key={db.name}>
                    <TableCell className="font-medium">
                      <TransitionLink href={href} className="flex items-center gap-2 hover:underline">
                        <CylinderIcon className="text-muted-foreground size-3.5" />
                        {db.name}
                      </TransitionLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {db.tables === null ? <span className="text-muted-foreground">—</span> : db.tables}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {db.sizeBytes === null ? <span className="text-muted-foreground">—</span> : formatBytes(db.sizeBytes)}
                    </TableCell>
                    <TableCell className="py-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" />}>
                          <MoreHorizontalIcon />
                          <span className="sr-only">More for {db.name}</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-48" align="end">
                          <DropdownMenuItem render={<TransitionLink href={href} />}>
                            <ExternalLinkIcon className="text-muted-foreground" />
                            Open
                          </DropdownMenuItem>
                          {/* A plain link so the browser streams the dump to a file. */}
                          <DropdownMenuItem
                            nativeButton={false}
                            render={<a href={exportUrl({ connectionId: connection.id, db: db.name }, { format: "sql" })} download />}
                          >
                            <DownloadIcon className="text-muted-foreground" />
                            Back up (SQL)
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setImporting(db.name)}>
                            <UploadIcon className="text-muted-foreground" />
                            Import…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDropping(db)}>
                            <Trash2Icon />
                            Drop
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateDatabaseDialog
        connectionId={connection.id}
        connectionName={connection.name}
        open={creating}
        onOpenChange={setCreating}
        onCreated={changed}
      />
      {importing !== null && databases.state === "loaded" && (
        <ImportDialog
          connection={connection}
          databases={databases.data.map((d) => d.name)}
          initial={importing}
          onOpenChange={(open) => {
            if (!open) {
              setImporting(null)
              void load()
            }
          }}
        />
      )}
      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(open) => !open && setDropping(null)}
        title={`Drop ${dropping?.name ?? "database"}?`}
        description="Every table in it, and every row, is gone for good."
        confirmLabel="Drop database"
        typeToConfirm={dropping?.name}
        onConfirm={async () => {
          if (!dropping) return
          await dropDatabase(connection.id, dropping.name)
          await changed()
        }}
      />
    </div>
  )
}

/**
 * The Import tab, aimed at a database chosen here. The tab reads its
 * database from the provider, so picking one is a matter of providing it.
 */
function ImportDialog({
  connection,
  databases,
  initial,
  onOpenChange,
}: {
  connection: DatabaseConnectionSummary
  databases: string[]
  initial: string
  onOpenChange: (open: boolean) => void
}) {
  const [db, setDb] = React.useState(initial || databases[0] || "")
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          <DialogDescription>A SQL script, or a CSV into one table, in the database chosen below.</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Into</span>
          <select
            value={db}
            onChange={(e) => setDb(e.target.value)}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-8 rounded-lg border px-2 font-mono text-xs outline-none focus-visible:ring-3 dark:bg-input/30"
          >
            {databases.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {db && (
          <div className="-mx-4 border-t">
            <DbProvider key={db} connection={connection} db={db}>
              <ImportTab />
            </DbProvider>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
