"use client"

import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import type { ViewMode } from "@/components/files-panel"
import type { Mode } from "@/components/view-mode-toggle"

/**
 * The phone picker's list of views, in the popover `ViewModeToggle` opens:
 * its own chunk (`on-demand.tsx`), so cmdk is not part of every page's
 * first load.
 */
export function ViewModeList({
  modes,
  mode,
  onSelect,
}: {
  modes: readonly Mode[]
  mode: ViewMode
  onSelect: (mode: ViewMode) => void
}) {
  return (
    <Command>
      <CommandList>
        <CommandGroup heading="View">
          {modes.map(({ id, label, icon: Icon }) => (
            <CommandItem key={id} value={id} data-checked={id === mode} onSelect={() => onSelect(id)}>
              <Icon className="size-3.5" />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
