"use client"

/**
 * The top of the icon rail: the current workspace's logo, or its initials
 * when it has none. Pressing it opens the workspace switcher, as the name
 * in the header does.
 *
 * A green dot at the corner while any of its sessions is running. The dot
 * has a ring in the sidebar's colour, so it looks cut out of the tile.
 */
export function WorkspaceLogo({
  name,
  logo,
  running,
  onClick,
}: {
  name: string
  /** A data URL from the Manage dialog, or null. */
  logo: string | null
  running: number
  onClick: () => void
}) {
  const label = `Switch workspace (${name})`
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={running > 0 ? `${label}, ${running} running` : label}
      className="group/logo focus-visible:ring-focus-ring relative mb-2 size-[34px] shrink-0 rounded-[10px] outline-none focus-visible:ring-2"
    >
      <span className="bg-accent-soft text-accent-strong grid size-full place-items-center overflow-hidden rounded-[10px] text-xs font-semibold">
        {logo ? (
          // A data URL, so next/image would gain nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="size-full object-cover" />
        ) : (
          initials(name)
        )}
      </span>
      {/* Over the image rather than around it, so a logo cannot cover its edge. */}
      <span
        className="ring-border group-hover/logo:ring-border-strong pointer-events-none absolute inset-0 rounded-[10px] ring-1 transition-shadow duration-150 ring-inset"
        aria-hidden
      />
      {running > 0 && (
        <span
          className="bg-success border-sidebar absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2"
          aria-hidden
        />
      )}
    </button>
  )
}

/** Up to two initials: "Acme Labs" -> "AL", "ucch" -> "UC". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}
