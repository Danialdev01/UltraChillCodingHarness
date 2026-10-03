"use client"

import * as React from "react"
import type { TableDetail } from "@ucch/protocol"

import { useDb } from "@/components/database/db-context"
import { RowForm } from "@/components/database/row-form-dialog"
import { insertRow } from "@/lib/database-api"

/** A row typed in by hand, as phpMyAdmin's Insert tab: the form, in the page. */
export function InsertTab({ detail, onInserted }: { detail: TableDetail; onInserted: () => void }) {
  const { ref } = useDb()
  const [inserted, setInserted] = React.useState<string | null>(null)
  const [round, setRound] = React.useState(0)

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-medium">Insert into {detail.name}</h2>
        <p className="text-muted-foreground text-xs">Fields left at their default are filled in by the engine.</p>
      </div>
      <div className="max-w-2xl rounded-lg border p-4">
        <RowForm
          detail={detail}
          resetKey={round}
          submitLabel="Insert row"
          onSubmit={async (values) => {
            const result = await insertRow(ref, detail.name, values)
            setInserted(result.insertId ? `Inserted row ${result.insertId}.` : "Row inserted.")
          }}
          onDone={() => setRound((r) => r + 1)}
          footer={(pending) => (
            <>
              {inserted && (
                <span role="status" className="text-muted-foreground mr-auto self-center text-xs">
                  {inserted}{" "}
                  <button type="button" className="underline" onClick={onInserted} disabled={pending}>
                    View data
                  </button>
                </span>
              )}
            </>
          )}
        />
      </div>
    </div>
  )
}
