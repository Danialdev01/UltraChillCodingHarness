"use client"

import * as React from "react"
import { ChevronsUpDownIcon } from "lucide-react"

import type { ReasoningEffort } from "@ucch/protocol"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export interface ModelChoice {
  id: string
  name: string
  provider: string
  contextLength: number | null
  reasoning: boolean
  /** Whether it accepts pictures. The catalogue's word, not a guess from the name. */
  images: boolean
}

/**
 * Loads OpenRouter's catalogue once per mount.
 *
 * The list is the server's, fetched and cached there, so the picker offers
 * models that actually exist rather than a hand-maintained shortlist that
 * quietly goes stale.
 */
export function useModels(): { models: ModelChoice[]; defaultModel: string | null } {
  const [models, setModels] = React.useState<ModelChoice[]>([])
  const [defaultModel, setDefaultModel] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch("/api/models", { credentials: "include" })
      if (!response.ok || cancelled) return
      const body = (await response.json()) as { models: ModelChoice[]; defaultModel: string }
      setModels(body.models)
      setDefaultModel(body.defaultModel)
    })().catch(() => {
      // An unreachable catalogue leaves the picker empty rather than breaking
      // the composer: the server still has a default model to fall back on.
    })
    return () => {
      cancelled = true
    }
  }, [])

  return { models, defaultModel }
}

// `max-w` in container units: these sit in the composer's controls row, and
// a 13rem model name beside the effort select and the context meter is what
// pushes that row onto three lines in a narrow chat.
const SELECT =
  "border-input bg-background focus-visible:ring-ring h-8 max-w-32 truncate rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:opacity-60 @md:max-w-52"

/** Rendered at once. The catalogue runs past four hundred entries. */
const MAX_RESULTS = 60

/**
 * The model, chosen by typing.
 *
 * A combobox rather than a `<select>`: OpenRouter lists hundreds of models
 * and a native list is only navigable if you already know where the one you
 * want sits. Searching matches the name *and* the id, because half of what
 * anyone knows a model by -- "sonnet", "gpt-5", "free" -- lives in the id
 * rather than the display name.
 *
 * The result list is capped and says so when it is truncated. Handing cmdk
 * four hundred rows to score and mount on every keystroke is a visibly slow
 * picker, and a search that needs one more character is not a hardship.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelChoice[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // Derived from `value` rather than mirrored in state, so the two can never
  // disagree -- and a saved model the catalogue no longer carries still shows
  // as its id instead of vanishing into "Select a model".
  const selected = models.find((model) => model.id === value)

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const hit = needle
      ? models.filter(
          (model) =>
            model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
        )
      : models
    return { shown: hit.slice(0, MAX_RESULTS), total: hit.length }
  }, [models, query])

  // Grouped by provider, which is the first thing anyone scans for.
  const groups = React.useMemo(() => {
    const byProvider = new Map<string, ModelChoice[]>()
    for (const model of matches.shown) {
      const list = byProvider.get(model.provider) ?? []
      list.push(model)
      byProvider.set(model.provider, list)
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [matches])

  const empty = models.length === 0

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // The next opening starts on the whole catalogue rather than on the
        // last search, which is rarely the one you want twice.
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Model"
            disabled={disabled || empty}
            className="h-8 w-52 justify-between px-2 text-xs font-normal"
          />
        }
      >
        <span className="truncate">
          {empty ? "Loading models…" : (selected?.name ?? value ?? "Select a model…")}
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>

      {/* Wider than the trigger: model names are long, and a panel clipped to
          a 13rem field would truncate every one of them. */}
      <PopoverContent className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search models…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>No model matches that.</CommandEmpty>
            {groups.map(([provider, entries]) => (
              <CommandGroup key={provider} heading={provider}>
                {entries.map((model) => (
                  <CommandItem
                    key={model.id}
                    // The id, not the name: cmdk's own filtering is off, so
                    // this is an identity rather than something to match on.
                    value={model.id}
                    // The row's own tick, which `CommandItem` renders and
                    // this is the switch for.
                    data-checked={model.id === value}
                    onSelect={() => {
                      onChange(model.id)
                      setOpen(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                    {model.reasoning && (
                      <span className="text-muted-foreground shrink-0 text-[10px]">reasons</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {matches.total > matches.shown.length && (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                {matches.total - matches.shown.length} more — keep typing to narrow it down.
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "high"]

export function EffortSelect({
  value,
  onChange,
  disabled,
  supported,
}: {
  value: ReasoningEffort
  onChange: (effort: ReasoningEffort) => void
  disabled?: boolean
  /** False when the chosen model does not reason, so effort would do nothing. */
  supported: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ReasoningEffort)}
      disabled={disabled || !supported}
      aria-label="Reasoning effort"
      title={supported ? "Reasoning effort" : "This model does not expose reasoning effort"}
      className={SELECT}
    >
      {EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          {effort === "off" ? "No reasoning" : `Effort: ${effort}`}
        </option>
      ))}
    </select>
  )
}
