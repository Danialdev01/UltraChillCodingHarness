import type { HarnessIconProps } from "./types"

/**
 * UCCH's own agent: the app's mark (`logo-mark.tsx`) at icon size.
 *
 * TODO: replace with the final UCCH Agent logo once there is one distinct
 * from the app's.
 */
export function UcchMark({ size = 16, title = "UCCH Agent", className }: HarnessIconProps) {
  return (
    <svg viewBox="0 0 8 8" width={size} height={size} role="img" aria-label={title} className={className}>
      <title>{title}</title>
      <path fill="currentColor" d="M0 0H6V1H1V7H7V2H8V8H0ZM2 2H6V3.5H5V3H3V5H5V4.5H6V6H2Z" />
      <rect x="7" y="0" width="1" height="1" className="fill-primary" />
    </svg>
  )
}
