"use client"

import * as React from "react"
import { Suspense } from "react"
import {
  DownloadIcon,
  ListTreeIcon,
  PlusIcon,
  TableIcon,
  TerminalIcon,
  UploadIcon,
  WrenchIcon,
} from "lucide-react"
import type { TableDetail } from "@ucch/protocol"

import { BrowseTab } from "@/components/database/browse-tab"
import { errorText, useDb, type Listing } from "@/components/database/db-context"
import { ExportTab } from "@/components/database/export-tab"
import { ImportTab } from "@/components/database/import-tab"
import { InsertTab } from "@/components/database/insert-tab"
import { OperationsTab } from "@/components/database/operations-tab"
import { SqlTab } from "@/components/database/sql-tab"
import { TableStructureTab } from "@/components/database/table-structure-tab"
import { useTab } from "@/components/database/use-tab"
import { ViewTabs, type ViewTab } from "@/components/database/view-tabs"
import { DatabaseViewSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { fetchTable } from "@/lib/database-api"
import { quoteIdent } from "@/lib/db-cells"

const TABS = [
  { id: "data", label: "Data", icon: TableIcon },
  { id: "structure", label: "Structure", icon: ListTreeIcon },
  { id: "sql", label: "SQL", icon: TerminalIcon },
  { id: "insert", label: "Insert", icon: PlusIcon },
  { id: "export", label: "Export", icon: DownloadIcon },
  { id: "import", label: "Import", icon: UploadIcon },
  { id: "operations", label: "Operations", icon: WrenchIcon },
] as const satisfies readonly ViewTab[]

const IDS = TABS.map((t) => t.id) as unknown as readonly ["data", "structure", "sql", "insert", "export", "import", "operations"]

/**
 * One table. Its description -- columns, keys, indexes -- is fetched once
 * here and handed to every tab, since all of them need it: the grid to know
 * which columns make a key, the form to know what to ask for, the structure
 * view to show it. `version` bumps after a structural change so the
 * description is re-read without the tabs each having to ask.
 */
export function TableView({ table }: { table: string }) {
  return (
    <Suspense fallback={<DatabaseViewSkeleton />}>
      <View table={table} />
    </Suspense>
  )
}

function View({ table }: { table: string }) {
  const { ref, engine } = useDb()
  const [tab, setTab] = useTab(IDS)
  const [detail, setDetail] = React.useState<Listing<TableDetail>>({ state: "loading" })
  const [version, setVersion] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setDetail((prev) => (prev.state === "loaded" ? prev : { state: "loading" }))
    fetchTable(ref, table)
      .then((data) => !cancelled && setDetail({ state: "loaded", data }))
      .catch((error) => !cancelled && setDetail({ state: "failed", error: errorText(error, "Could not read the table.") }))
    return () => {
      cancelled = true
    }
  }, [ref, table, version])

  const reload = React.useCallback(() => setVersion((v) => v + 1), [])

  // Its structure changed in another tab.
  const { change } = useDb()
  React.useEffect(() => {
    if (change && (change.table === table || change.table === "")) reload()
  }, [change, table, reload])
  const isView = detail.state === "loaded" && detail.data.tableType === "view"
  const tabs = isView ? TABS.filter((t) => t.id !== "insert" && t.id !== "import") : TABS

  return (
    <>
      <ViewTabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="flex min-h-0 flex-1 flex-col">
        {detail.state === "loading" ? (
          <DatabaseViewSkeleton />
        ) : detail.state === "failed" ? (
          <div className="p-4">
            <p role="alert" className="text-destructive text-sm">
              {detail.error}
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {tab === "data" && <BrowseTab table={table} detail={detail.data} />}
            {tab === "structure" && <TableStructureTab detail={detail.data} onChanged={reload} />}
            {tab === "sql" && <SqlTab initial={`SELECT * FROM ${quoteIdent(table, engine)} LIMIT 100;`} />}
            {tab === "insert" && <InsertTab detail={detail.data} onInserted={() => setTab("data")} />}
            {tab === "export" && <ExportTab table={table} />}
            {tab === "import" && <ImportTab table={table} />}
            {tab === "operations" && <OperationsTab detail={detail.data} />}
          </>
        )}
      </div>
    </>
  )
}
