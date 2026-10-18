/**
 * One colour per person, the same everywhere they appear -- their avatar
 * ring in a presence stack, their caret in a shared note -- and the same in
 * every tab, since it comes from their id alone.
 *
 * Lightness and chroma are fixed where a caret reads on both the light and
 * the dark palette; only the hue varies, spread by the golden angle so two
 * people rarely land close together.
 */
export function personHue(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return Math.round((hash * 137.508) % 360)
}

export function personColor(userId: string): string {
  return `oklch(0.66 0.15 ${personHue(userId)})`
}

/** Initials for an avatar with no picture. */
export function initialsOf(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  return (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase()
}
