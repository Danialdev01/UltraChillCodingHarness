"use client"

/**
 * Who else has this page open. Today that is you in another window; once
 * projects are shared it is the people you share with.
 */
export function PresenceBadge({ others }: { others: readonly { clientId: string; editing: boolean }[] }) {
  if (others.length === 0) return null
  const typing = others.some((o) => o.editing)
  return (
    <span
      className={
        "flex items-center gap-1 text-[11px] " + (typing ? "text-warning" : "text-muted-foreground")
      }
      title="Changes made there appear here as they are saved. If you both edit at once, the later save is reverted."
    >
      <span aria-hidden className={"size-1.5 rounded-full " + (typing ? "animate-pulse bg-warning" : "bg-success")} />
      {typing
        ? "Being edited in another window"
        : others.length === 1
          ? "Also open in another window"
          : `Also open in ${others.length} other windows`}
    </span>
  )
}
