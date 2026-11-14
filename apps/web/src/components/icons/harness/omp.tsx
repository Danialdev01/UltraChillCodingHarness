import type { HarnessIconProps } from "./types"

/**
 * The mark for the Default harness: OMP (oh-my-pi), which serves it, drawn
 * as its π in a rounded tile. `currentColor`, so it follows the theme as
 * the other marks do.
 *
 * Drawn here rather than copied from OMP's artwork; swap in the official
 * SVG if one is published under a licence that allows it.
 */
export function OmpMark({ size = 16, title = "Default", className }: HarnessIconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={title} className={className}>
      <title>{title}</title>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.5 8.5h11M9.5 8.5v8.5M14.5 8.5v6.5c0 1.2.6 2 1.8 2"
      />
    </svg>
  )
}
