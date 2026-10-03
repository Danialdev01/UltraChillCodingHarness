"use client"

import * as React from "react"
import { ShuffleIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EMOJI_GROUPS, randomEmoji, searchEmoji } from "@/lib/emoji-search"
import { cn } from "@/lib/utils"

/**
 * A grid of emoji behind a trigger: for a page's icon, and a callout's.
 *
 * Search filters across every group; with nothing typed the groups show
 * under their headings. "Remove" is offered only when there is something
 * to remove, so the picker for a page without an icon has no dead button.
 */
export function EmojiPicker({
  value,
  onPick,
  children,
  align = "start",
}: {
  value: string | null
  onPick(emoji: string | null): void
  /** The trigger; rendered as the popover's anchor. */
  children: React.ReactElement
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const results = React.useMemo(() => searchEmoji(query), [query])
  const searching = query.trim().length > 0

  const pick = (emoji: string | null) => {
    onPick(emoji)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger render={children} />
      <PopoverContent align={align} className="w-80 p-2" onKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji…"
            aria-label="Search emoji"
            className="bg-background h-7 min-w-0 flex-1 rounded border px-2 text-xs outline-none"
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0]) {
                event.preventDefault()
                pick(results[0].char)
              }
            }}
          />
          <Button variant="ghost" size="icon-xs" title="Random" onClick={() => pick(randomEmoji())}>
            <ShuffleIcon />
          </Button>
          {value && (
            <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => pick(null)}>
              <XIcon />
            </Button>
          )}
        </div>
        <div className="mt-2 max-h-64 overflow-y-auto">
          {results.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-xs">No emoji match.</p>
          ) : searching ? (
            <Grid entries={results} current={value} onPick={pick} />
          ) : (
            EMOJI_GROUPS.map((group) => (
              <div key={group.id} className="mb-1">
                <p className="text-muted-foreground px-1 py-1 text-[10px] font-medium tracking-wide uppercase">
                  {group.label}
                </p>
                <Grid
                  entries={results.filter((e) => e.group === group.id)}
                  current={value}
                  onPick={pick}
                />
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Grid({
  entries,
  current,
  onPick,
}: {
  entries: readonly { char: string; name: string }[]
  current: string | null
  onPick(emoji: string): void
}) {
  return (
    <div className="grid grid-cols-8">
      {entries.map((entry) => (
        <button
          key={entry.char}
          type="button"
          title={entry.name}
          onClick={() => onPick(entry.char)}
          className={cn(
            "hover:bg-muted flex size-9 items-center justify-center rounded text-xl",
            entry.char === current && "bg-muted ring-ucch-active ring-1",
          )}
        >
          {entry.char}
        </button>
      ))}
    </div>
  )
}
