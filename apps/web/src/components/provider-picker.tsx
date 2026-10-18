"use client"

import * as React from "react"
import { BotIcon } from "lucide-react"

import { PickerChevron, pickerTrigger, type PickerLook } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  fetchProviders,
  providerBlocker,
  type ProviderCard,
  type ProviderId,
} from "@/lib/providers-api"

export interface ProvidersState {
  cards: Record<ProviderId, ProviderCard> | null
  defaultProvider: ProviderId | null
}

/** The provider cards, fetched once per mount. Null until they land. */
export function useProviders(): ProvidersState {
  const [state, setState] = React.useState<ProvidersState>({ cards: null, defaultProvider: null })
  React.useEffect(() => {
    let cancelled = false
    void fetchProviders()
      .then((data) => {
        if (!cancelled) setState({ cards: data.providers, defaultProvider: data.defaultProvider })
      })
      .catch(() => {
        // The picker then offers the native loop alone, which is the state
        // every install starts in anyway.
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

const ORDER: ProviderId[] = ["native", "claude", "codex"]

/**
 * Which backend answers the next message.
 *
 * The same popover as the model and effort pickers beside it, so the row
 * reads as one set of controls. No search box: there are three entries, and
 * the interesting part is which ones are greyed out and why -- each row says.
 * Once a thread has run it is bound to its provider and the trigger locks,
 * because the server would refuse a switch and a control that looks live but
 * is not is worse than one that says so.
 */
export function ProviderSelect({
  providers,
  value,
  locked,
  onChange,
  disabled,
  look = "field",
}: {
  providers: ProvidersState
  value: ProviderId
  /** The thread's binding, when it has one. */
  locked: ProviderId | null
  onChange: (id: ProviderId) => void
  disabled?: boolean
  look?: PickerLook
}) {
  const [open, setOpen] = React.useState(false)
  const cards = providers.cards
  const current = cards?.[value]
  const blocker = current ? providerBlocker(current) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...pickerTrigger(look, look === "inline" ? "text-muted-foreground" : "w-36")}
            role="combobox"
            aria-expanded={open}
            aria-label="Harness"
            disabled={disabled || locked !== null}
            title={
              locked
                ? `This thread runs on ${cards?.[locked]?.label ?? locked}. Clear the context to switch.`
                : (blocker ?? `Harness: ${current?.label ?? value}`)
            }
          />
        }
      >
        {look === "inline" ? (
          // On the toolbar, a narrow panel shows the robot alone; the name
          // is in the title and in the list it opens.
          <>
            <BotIcon className="size-4 @md:hidden" />
            <span className="sr-only @md:not-sr-only @md:truncate">{current?.label ?? value}</span>
            <span className="hidden @md:contents">
              <PickerChevron look={look} />
            </span>
          </>
        ) : (
          <>
            <span className="truncate">{current?.label ?? value}</span>
            <PickerChevron look={look} />
          </>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading="Harness">
              {ORDER.map((id) => {
                const card = cards?.[id]
                const why = card ? providerBlocker(card) : id === "native" ? null : "Checking…"
                return (
                  <CommandItem
                    key={id}
                    value={id}
                    data-checked={id === value}
                    // The current one stays selectable even when blocked, so
                    // the list never hides where you are.
                    disabled={why !== null && id !== value}
                    title={why ?? undefined}
                    onSelect={() => {
                      onChange(id)
                      setOpen(false)
                    }}
                  >
                    <span className="shrink-0">{card?.label ?? id}</span>
                    {why && (
                      <span className="text-muted-foreground ml-auto min-w-0 truncate text-[10px]">
                        {why}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
