"use client"

import * as React from "react"

import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

export interface PickerItem {
  /** What `onPick` receives; must be unique within the list. */
  value: string
  label: React.ReactNode
  /** Extra text for the fuzzy filter to match on, beyond `value`. */
  keywords?: string[]
}

/**
 * The minibuffer behind the leader menus: a list, a filter, arrows and Enter.
 *
 * One component for `SPC s s`, `SPC .` and `SPC ,` because they are the same
 * interaction with different rows -- which is what Doom's completing-read is.
 * It is the command palette's dialog rather than a second popup, so it looks
 * and moves like the one behind ctrl-K.
 *
 * Two ways to filter: with `filter`, the caller narrows the rows itself for
 * each query and the dialog shows exactly those, which is how the line search
 * keeps every-word matching and a cap on how many rows are rendered. Without
 * it, cmdk's own fuzzy match runs over `value` and `keywords`, the right thing
 * for picking one path out of a tree.
 */
export function LeaderPicker({
  open,
  onOpenChange,
  title,
  placeholder,
  items,
  filter,
  initialValue,
  onPick,
  empty = "No matches.",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  placeholder: string
  items: readonly PickerItem[]
  filter?: (query: string) => readonly PickerItem[]
  /** The row highlighted when the dialog opens: where you already are. */
  initialValue?: string
  onPick: (value: string) => void
  empty?: string
}) {
  const [query, setQuery] = React.useState("")
  const [value, setValue] = React.useState(initialValue ?? "")

  // Fresh each time it opens: the query from last time is never the one
  // wanted now, and the highlight should start where the cursor is today.
  React.useEffect(() => {
    if (!open) return
    setQuery("")
    setValue(initialValue ?? "")
  }, [open, initialValue])

  const rows = filter ? filter(query) : items

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={placeholder}
      className="sm:max-w-2xl"
      commandProps={{
        shouldFilter: !filter,
        value,
        onValueChange: setValue,
        loop: true,
      }}
    >
      <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
      <CommandList className="max-h-96">
        <CommandEmpty>{empty}</CommandEmpty>
        {rows.map((item) => (
          <CommandItem
            key={item.value}
            value={item.value}
            keywords={item.keywords}
            onSelect={() => {
              onOpenChange(false)
              onPick(item.value)
            }}
          >
            {item.label}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
