import { BotIcon } from "lucide-react"

import type { HarnessIconProps } from "./types"

/** Any harness the registry does not know, or a session not bound to one yet. */
export function UnknownMark({ size = 16, title = "Agent", className }: HarnessIconProps) {
  return <BotIcon width={size} height={size} role="img" aria-label={title} className={className}><title>{title}</title></BotIcon>
}
