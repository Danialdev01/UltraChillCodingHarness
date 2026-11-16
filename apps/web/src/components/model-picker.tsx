"use client"

import * as React from "react"
import { ChevronDownIcon, ChevronsUpDownIcon, GaugeIcon } from "lucide-react"

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
import { Skeleton } from "@/components/ui/skeleton"
import { keyedModel, type ModelKeyKind } from "@/lib/model-keys"
import { cn } from "@/lib/utils"

/**
 * How a picker's trigger looks: a bordered field, for forms; or plain text
 * on the composer's toolbar, where a row of boxes would outweigh the box you
 * type in.
 */
export type PickerLook = "field" | "inline"

/** The trigger's button styling for a look; `className` sizes the field one. */
export function pickerTrigger(look: PickerLook, className: string) {
  return look === "inline"
    ? {
        variant: "ghost" as const,
        className: cn(
          "h-7 w-auto max-w-44 min-w-0 shrink justify-start gap-1 px-1.5 text-xs font-normal",
          className,
        ),
      }
    : { variant: "outline" as const, className: cn("h-8 justify-between px-2 text-xs font-normal", className) }
}

/** The chevron that goes with it. */
export function PickerChevron({ look }: { look: PickerLook }) {
  return look === "inline" ? (
    <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
  ) : (
    <ChevronsUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
  )
}

export interface ModelChoice {
  id: string
  name: string
  provider: string
  contextLength: number | null
  reasoning: boolean
  /** Whether it accepts pictures. The catalogue's word, not a guess from the name. */
  images: boolean
  /** The named key it bills; its id is then of the form `@<keyId>/<model>`. */
  source?: ModelSource
  /** AnonRouter's word that it is tuned to refuse less. Only AnonRouter sets it. */
  uncensored?: boolean
}

export interface ModelSource {
  id: string
  name: string
  kind: ModelKeyKind
}

interface ModelsBody {
  models: ModelChoice[]
  defaultModel: string
  keys?: { id: string; name: string; kind: ModelKeyKind }[]
  catalogues?: Partial<Record<ModelKeyKind, ModelChoice[]>>
}

/**
 * The composer's list for Custom: each named key's catalogue, each model
 * tagged with the key it bills. With no named keys yet it is the OpenRouter
 * catalogue as before, which the server runs on the account's OpenRouter key
 * until a named one exists.
 */
export function composeKeyedModels(body: ModelsBody): { models: ModelChoice[]; defaultModel: string } {
  const keys = body.keys ?? []
  if (keys.length === 0) return { models: body.models, defaultModel: body.defaultModel }
  const out: ModelChoice[] = []
  for (const key of keys) {
    const source: ModelSource = { id: key.id, name: key.name, kind: key.kind }
    for (const m of body.catalogues?.[key.kind] ?? []) out.push({ ...m, id: keyedModel(key.id, m.id), source })
  }
  // The account's default model under the first key that has it; else the
  // first key's first model.
  const ids = new Set(out.map((m) => m.id))
  const defaultModel =
    keys.map((k) => keyedModel(k.id, body.defaultModel)).find((id) => ids.has(id)) ??
    out[0]?.id ??
    body.defaultModel
  return { models: out, defaultModel }
}

/**
 * Loads the model catalogue once per mount.
 *
 * The list is the server's, fetched and cached there, so the picker offers
 * models that actually exist rather than a hand-maintained shortlist that
 * quietly goes stale. `keyed` is the composer's list: every key the account
 * has, each model under the key it bills. Elsewhere -- the account's default
 * model, a task's model -- it is the OpenRouter catalogue.
 */
export function useModels({ keyed = false }: { keyed?: boolean } = {}): {
  models: ModelChoice[]
  defaultModel: string | null
} {
  const [models, setModels] = React.useState<ModelChoice[]>([])
  const [defaultModel, setDefaultModel] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch("/api/models", { credentials: "include" })
      if (!response.ok || cancelled) return
      const body = (await response.json()) as ModelsBody
      const composed = keyed ? composeKeyedModels(body) : { models: body.models, defaultModel: body.defaultModel }
      setModels(composed.models)
      setDefaultModel(composed.defaultModel)
    })().catch(() => {
      // An unreachable catalogue leaves the picker empty rather than breaking
      // the composer: the server still has a default model to fall back on.
    })
    return () => {
      cancelled = true
    }
  }, [keyed])

  return { models, defaultModel }
}

/** The keys a list spans, in the order they first appear. */
export function sourcesOf(models: ModelChoice[]): ModelSource[] {
  const seen = new Map<string, ModelSource>()
  for (const m of models) {
    if (!m.source) continue
    if (!seen.has(m.source.id)) seen.set(m.source.id, m.source)
  }
  return [...seen.values()]
}

/** Listed under Uncensored: AnonRouter's flag, on a model billed to an AnonRouter key. */
function isUncensored(model: ModelChoice): boolean {
  return model.uncensored === true && model.source?.kind === "anonrouter"
}

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
  look = "field",
}: {
  models: ModelChoice[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  look?: PickerLook
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // Derived from `value` rather than mirrored in state, so the two can never
  // disagree -- and a saved model the catalogue no longer carries still shows
  // as its id instead of vanishing into "Select a model".
  const selected = models.find((model) => model.id === value)

  // Several keys: a row of them above the list, by the names they were
  // given, and the list is one key's models at a time.
  const sources = React.useMemo(() => sourcesOf(models), [models])
  const multi = sources.length > 1
  const [sourceId, setSourceId] = React.useState<string | undefined>(undefined)
  const activeSource = multi ? (sourceId !== undefined ? sourceId : (selected?.source?.id ?? sources[0]!.id)) : undefined

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const pool = activeSource === undefined ? models : models.filter((m) => m.source?.id === activeSource)
    const hit = needle
      ? pool.filter(
          (model) =>
            model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
        )
      : pool
    // AnonRouter's uncensored models first, so the cap never hides them.
    const ordered = [...hit.filter((m) => isUncensored(m)), ...hit.filter((m) => !isUncensored(m))]
    return { shown: ordered.slice(0, MAX_RESULTS), total: hit.length }
  }, [models, query, activeSource])

  // AnonRouter's uncensored models under a heading of their own, then the
  // rest grouped by provider, which is the first thing anyone scans for.
  const uncensored = React.useMemo(() => matches.shown.filter(isUncensored), [matches])
  const groups = React.useMemo(() => {
    const byProvider = new Map<string, ModelChoice[]>()
    for (const model of matches.shown) {
      if (isUncensored(model)) continue
      const list = byProvider.get(model.provider) ?? []
      list.push(model)
      byProvider.set(model.provider, list)
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [matches])

  const empty = models.length === 0

  function row(model: ModelChoice) {
    return (
      <CommandItem
        key={model.id}
        // The id, not the name: cmdk's own filtering is off, so this is an
        // identity rather than something to match on.
        value={model.id}
        // The row's own tick, which `CommandItem` renders and this is the
        // switch for.
        data-checked={model.id === value}
        onSelect={() => {
          onChange(model.id)
          setOpen(false)
        }}
      >
        <span className="min-w-0 flex-1 truncate">{model.name}</span>
        {model.reasoning && <span className="text-muted-foreground shrink-0 text-[10px]">reasons</span>}
      </CommandItem>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // The next opening starts on the whole catalogue rather than on the
        // last search, which is rarely the one you want twice -- and on the
        // key the chosen model bills.
        if (!next) {
          setQuery("")
          setSourceId(undefined)
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            {...pickerTrigger(look, look === "inline" ? "text-foreground font-medium" : "w-52")}
            role="combobox"
            aria-expanded={open}
            aria-label="Model"
            title={multi && selected?.source ? `${selected.name} · ${selected.source.name} key` : undefined}
            disabled={disabled || empty}
          />
        }
      >
        <span className="truncate">
          {empty ? <Skeleton className="h-3 w-24" /> : (selected?.name ?? value ?? "Select a model…")}
        </span>
        {!empty && multi && selected?.source && (
          <span className="text-muted-foreground hidden max-w-20 shrink-0 truncate font-normal @lg:inline">
            {selected.source.name}
          </span>
        )}
        <PickerChevron look={look} />
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
          {multi && (
            <div role="tablist" aria-label="API key" className="flex gap-1 overflow-x-auto border-b px-2 py-1.5">
              {sources.map((source) => {
                const on = source.id === activeSource
                return (
                  <button
                    key={source.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setSourceId(source.id)}
                    title={`${source.name} (${source.kind === "anonrouter" ? "AnonRouter" : "OpenRouter"})`}
                    className={cn(
                      "inline-flex h-6 max-w-40 shrink-0 items-center gap-1 truncate rounded-md border px-2 text-xs transition-colors outline-none",
                      "focus-visible:ring-ring focus-visible:ring-2",
                      on ? "bg-muted text-foreground border-foreground/20" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <span className="truncate">{source.name}</span>
                    <span className="text-muted-foreground text-[10px] uppercase">
                      {source.kind === "anonrouter" ? "AR" : "OR"}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          <CommandList className="max-h-72">
            <CommandEmpty>No model matches that.</CommandEmpty>
            {uncensored.length > 0 && (
              <CommandGroup heading="Uncensored">{uncensored.map(row)}</CommandGroup>
            )}
            {groups.map(([provider, entries]) => (
              <CommandGroup key={provider} heading={provider}>
                {entries.map(row)}
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

const LEVELS: Record<ReasoningEffort, { label: string; hint: string }> = {
  off: { label: "No reasoning", hint: "Fastest" },
  low: { label: "Low", hint: "A little thinking first" },
  medium: { label: "Medium", hint: "Balanced" },
  high: { label: "High", hint: "Slower, more thorough" },
  xhigh: { label: "Extra high", hint: "Slower still" },
  max: { label: "Max", hint: "Slowest, most thorough" },
}

/** What OpenRouter takes. Claude Code's levels come from its model list. */
export const NATIVE_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"]

/**
 * What an effort level is called and what it means. Under a CLI, `off` passes
 * no flag and the CLI uses the model's own default -- which is not the same as
 * not reasoning, so it is not called that.
 */
export function describeEffort(effort: ReasoningEffort, offMeansDefault?: boolean) {
  return effort === "off" && offMeansDefault
    ? { label: "Default", hint: "The model's own setting" }
    : LEVELS[effort]
}

/**
 * The reasoning effort, in the same popover as the model picker so the two
 * read as one row of controls.
 *
 * No search box: a handful of fixed choices are faster clicked than typed.
 * The caller decides which levels the model takes and renders nothing for
 * one that takes none -- a control that does nothing is noise.
 */
export function EffortSelect({
  value,
  levels,
  offMeansDefault,
  onChange,
  disabled,
  look = "field",
}: {
  value: ReasoningEffort
  /** Lowest first, `off` included when it is a choice. */
  levels: readonly ReasoningEffort[]
  /**
   * Under a CLI, `off` passes no flag and the CLI uses the model's own
   * default -- which is not the same as not reasoning, so it is not called that.
   */
  offMeansDefault?: boolean
  onChange: (effort: ReasoningEffort) => void
  disabled?: boolean
  look?: PickerLook
}) {
  const [open, setOpen] = React.useState(false)
  const describe = (effort: ReasoningEffort) => describeEffort(effort, offMeansDefault)
  const options = levels.map((effort) => ({ value: effort, ...describe(effort) }))
  const current = levels.includes(value) ? value : levels[0]!
  const selected = { value: current, ...describe(current) }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...pickerTrigger(look, look === "inline" ? "text-muted-foreground shrink-0" : "w-32")}
            role="combobox"
            aria-expanded={open}
            aria-label="Reasoning effort"
            title={`Reasoning effort: ${selected.label}`}
            disabled={disabled}
          />
        }
      >
        {/* On a narrow toolbar the gauge alone holds the place, so the model
            beside it keeps its name; the level is in the title and the list. */}
        {look === "inline" && <GaugeIcon className="size-3.5 shrink-0 @lg:hidden" />}
        <span className={cn("truncate", look === "inline" && "sr-only @lg:not-sr-only")}>
          {/* Beside the model on the toolbar, the level alone says enough. */}
          {selected.value === "off" || look === "inline"
            ? selected.label
            : `Effort: ${selected.label.toLowerCase()}`}
        </span>
        <span className={look === "inline" ? "hidden @lg:contents" : "contents"}>
          <PickerChevron look={look} />
        </span>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading="Reasoning effort">
              {options.map((effort) => (
                <CommandItem
                  key={effort.value}
                  value={effort.value}
                  data-checked={effort.value === value}
                  onSelect={() => {
                    onChange(effort.value)
                    setOpen(false)
                  }}
                >
                  <span className="shrink-0">{effort.label}</span>
                  <span className="text-muted-foreground ml-auto min-w-0 truncate text-[10px]">
                    {effort.hint}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
