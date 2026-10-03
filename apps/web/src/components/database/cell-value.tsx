"use client"

import type { Cell } from "@ucch/protocol"

import { formatCell } from "@/lib/db-cells"
import { cn } from "@/lib/utils"

/** One cell as the grid and the result tables draw it. */
export function CellValue({ cell, className }: { cell: Cell; className?: string }) {
  const shown = formatCell(cell)
  switch (shown.kind) {
    case "null":
      return <span className={cn("text-muted-foreground italic", className)}>NULL</span>
    case "bool":
      return <span className={cn("font-mono", className)}>{shown.value ? "true" : "false"}</span>
    case "bytes":
      return <span className={cn("text-muted-foreground font-mono", className)}>{shown.label}</span>
    case "text":
      return (
        <span className={cn(typeof cell === "number" && "tabular-nums", className)} title={shown.truncated ? shown.full : undefined}>
          {shown.text}
        </span>
      )
  }
}
