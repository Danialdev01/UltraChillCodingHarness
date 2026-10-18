"use client"

import * as React from "react"
import type { DatabaseConnectionSummary, DatabaseEngine, TableSummary } from "@ucch/protocol"

import { fetchTables, type DbRef } from "@/lib/database-api"
import { useLiveResource } from "@/lib/realtime"
import { useCachedState } from "@/lib/queries/cached-state"
import { qk } from "@/lib/query-keys"

export type Listing<T> =
  | { state: "loading" }
  | { state: "loaded"; data: T }
  | { state: "failed"; error: string }

interface DbContextValue {
  connection: DatabaseConnectionSummary
  db: string
  ref: DbRef
  engine: DatabaseEngine
  /** Every table and view in the database, shared by the column and the views. */
  tables: Listing<TableSummary[]>
  /** After anything that adds, removes or renames a table. */
  reloadTables: () => Promise<void>
  /**
   * The last change another tab made in this database: to one table, or to
   * `""` when it could have touched any (SQL, an import, a new table).
   */
  change: { table: string; at: number } | null
}

const DbContext = React.createContext<DbContextValue | null>(null)

export function useDb(): DbContextValue {
  const context = React.useContext(DbContext)
  if (!context) throw new Error("useDb must be used within a DbProvider.")
  return context
}

/**
 * One open database, for everything rendered inside it.
 *
 * The table list is fetched here, once, rather than by each view that
 * shows it: the column on the right, the Structure tab and the export and
 * import pickers all read the same list, and a table created in one is
 * seen by the others without each having to ask the server again.
 */
export function DbProvider({
  connection,
  db,
  children,
}: {
  connection: DatabaseConnectionSummary
  db: string
  children: React.ReactNode
}) {
  const ref = React.useMemo<DbRef>(() => ({ connectionId: connection.id, db }), [connection.id, db])
  // Cached: reopening a database lists its tables at once, then revalidates.
  const [listed, , reloadTables, listState] = useCachedState(
    qk.database.tables(connection.id, db),
    () => fetchTables(ref),
    { persist: true },
  )
  const tables = React.useMemo<Listing<TableSummary[]>>(
    () =>
      listed
        ? { state: "loaded", data: listed }
        : listState.error
          ? { state: "failed", error: listState.error.message || "Could not list the tables." }
          : { state: "loading" },
    [listed, listState.error],
  )

  // Another tab wrote here: the list may have changed, and the open table's
  // views refetch from `change`. Last write wins on rows -- an external
  // database has no version to check a save against.
  const [change, setChange] = React.useState<DbContextValue["change"]>(null)
  const prefix = `${connection.id}/${db}/`
  useLiveResource("database_data", (event) => {
    if (!event.id?.startsWith(prefix)) return
    void reloadTables()
    setChange({ table: event.id.slice(prefix.length), at: Date.now() })
  })

  const value = React.useMemo<DbContextValue>(
    () => ({ connection, db, ref, engine: connection.engine, tables, reloadTables, change }),
    [connection, db, ref, tables, reloadTables, change],
  )

  return <DbContext.Provider value={value}>{children}</DbContext.Provider>
}

/** The error text of a thrown value, for the `role="alert"` line beside an action. */
export function errorText(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error ? error.message : fallback
}
