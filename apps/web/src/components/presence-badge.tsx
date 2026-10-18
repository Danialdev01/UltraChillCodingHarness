"use client"

import type { PresenceViewer } from "@ucch/protocol"

import { initialsOf, personColor } from "@/lib/person-color"
import { useRealtime } from "@/lib/realtime"

/**
 * Who else has this page open: a small stack of the people (and your own
 * other windows), each in the colour their caret has in a shared editor.
 * Hover for names; a ring that pulses is someone typing right now.
 */
export function PresenceBadge({ others }: { others: readonly PresenceViewer[] }) {
  const me = useRealtime().client?.userId ?? null
  if (others.length === 0) return null

  // One avatar per person, however many windows they have open.
  const people = new Map<string, { viewer: PresenceViewer; windows: number; editing: boolean }>()
  for (const viewer of others) {
    const seen = people.get(viewer.userId)
    if (seen) {
      seen.windows++
      seen.editing ||= viewer.editing
    } else people.set(viewer.userId, { viewer, windows: 1, editing: viewer.editing })
  }
  const label = (userId: string, name: string | undefined, windows: number) =>
    userId === me
      ? windows === 1
        ? "You, in another window"
        : `You, in ${windows} other windows`
      : (name ?? "Someone")
  const list = [...people.values()]
  const typing = list.some((p) => p.editing)
  const names = list.map((p) => label(p.viewer.userId, p.viewer.name, p.windows))

  return (
    <span
      className={"flex items-center gap-1.5 text-[11px] " + (typing ? "text-warning" : "text-muted-foreground")}
      title={`${names.join(", ")} -- ${typing ? "editing now" : "also here"}`}
    >
      <span className="flex -space-x-1.5">
        {list.slice(0, 4).map(({ viewer, editing }) => (
          <span
            key={viewer.userId}
            className={
              "bg-muted text-foreground ring-background flex size-5 items-center justify-center overflow-hidden rounded-full text-[9px] font-medium ring-2 " +
              (editing ? "animate-pulse" : "")
            }
            style={{ boxShadow: `0 0 0 2px ${personColor(viewer.userId)}` }}
          >
            {viewer.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={viewer.avatarUrl} alt="" width={20} height={20} loading="lazy" decoding="async" className="size-full object-cover" />
            ) : (
              initialsOf(viewer.userId === me ? "You" : viewer.name)
            )}
          </span>
        ))}
      </span>
      <span className="truncate">
        {list.length === 1 ? names[0] : `${names.length} others`}
        {typing ? " · editing" : ""}
      </span>
    </span>
  )
}
