"use client"

import { Suspense } from "react"
import { DownloadIcon, ListTreeIcon, TerminalIcon, UploadIcon, UsersIcon } from "lucide-react"

import { ExportTab } from "@/components/database/export-tab"
import { ImportTab } from "@/components/database/import-tab"
import { PermissionsTab } from "@/components/database/permissions-tab"
import { SqlTab } from "@/components/database/sql-tab"
import { StructureTab } from "@/components/database/structure-tab"
import { useTab } from "@/components/database/use-tab"
import { ViewTabs, type ViewTab } from "@/components/database/view-tabs"
import { DatabaseViewSkeleton } from "@/components/page-skeletons"

const TABS = [
  { id: "structure", label: "Structure", icon: ListTreeIcon },
  { id: "sql", label: "SQL", icon: TerminalIcon },
  { id: "import", label: "Import", icon: UploadIcon },
  { id: "export", label: "Export", icon: DownloadIcon },
  { id: "permissions", label: "Permissions", icon: UsersIcon },
] as const satisfies readonly ViewTab[]

const IDS = TABS.map((t) => t.id) as unknown as readonly ["structure", "sql", "import", "export", "permissions"]

/** The database as a whole: what phpMyAdmin shows when you click a database name. */
export function DatabaseHome() {
  // Suspense because the tab hook reads the search params, which Next
  // wants fenced off from any static parent.
  return (
    <Suspense fallback={<DatabaseViewSkeleton />}>
      <Home />
    </Suspense>
  )
}

function Home() {
  const [tab, setTab] = useTab(IDS)
  return (
    <>
      <ViewTabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "structure" && <StructureTab />}
        {tab === "sql" && <SqlTab />}
        {tab === "import" && <ImportTab />}
        {tab === "export" && <ExportTab />}
        {tab === "permissions" && <PermissionsTab />}
      </div>
    </>
  )
}
