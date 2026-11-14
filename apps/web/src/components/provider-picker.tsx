"use client"

import * as React from "react"

import { HarnessIcon } from "@/components/harness-icon"
import { PickerChevron, pickerTrigger, type PickerLook } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  accountStatus,
  fetchAccounts,
  fetchProviders,
  providerBlocker,
  type AgentAccount,
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

/** The caller's own subscription accounts, fetched once per mount. Null until they land. */
export function useAccounts(): { accounts: AgentAccount[] | null; reload: () => void } {
  const [accounts, setAccounts] = React.useState<AgentAccount[] | null>(null)
  const [generation, setGeneration] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    void fetchAccounts()
      .then((list) => {
        if (!cancelled) setAccounts(list)
      })
      .catch(() => {
        // No accounts to pick from: every turn runs on the Default one.
        if (!cancelled) setAccounts([])
      })
    return () => {
      cancelled = true
    }
  }, [generation])
  return { accounts, reload: React.useCallback(() => setGeneration((g) => g + 1), []) }
}

/** Why an account cannot be picked now, or null. */
function accountBlocker(account: AgentAccount): string | null {
  if (account.limitedUntil) return accountStatus(account).label
  if (account.authStatus !== "signed_in") return "Sign in to it in Settings -> Harness"
  return null
}

const ORDER: ProviderId[] = ["native", "claude", "codex"]

/**
 * Which backend answers the next message.
 *
 * The same popover as the model and effort pickers beside it, so the row
 * reads as one set of controls. No search box: there are three entries, and
 * the interesting part is which ones are greyed out and why -- each row says.
 * Once a thread has run it is bound to its provider. With `onSwitch` the
 * picker stays open on a bound thread and picking another harness switches
 * the session to it (`thread.switch_harness`: same session, a brief of the
 * work so far); without it the trigger locks, because the server would
 * refuse a plain send to another provider.
 */
export function ProviderSelect({
  providers,
  value,
  locked,
  onChange,
  onSwitch,
  accounts,
  currentProfileId,
  onAccount,
  disabled,
  look = "field",
}: {
  providers: ProvidersState
  value: ProviderId
  /** The thread's binding, when it has one. */
  locked: ProviderId | null
  onChange: (id: ProviderId) => void
  /** Picking another harness on a bound thread switches the session to it. */
  onSwitch?: (id: ProviderId) => void
  /**
   * The person's subscription accounts. With more than one for the
   * harness in use, the list offers them: on a bound session picking one
   * moves it there (a person's choice, never the server's); before the
   * first turn it is the account new turns here start on.
   */
  accounts?: AgentAccount[] | null
  /** The account in use, when one is known. */
  currentProfileId?: string | null
  onAccount?: (account: AgentAccount) => void
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
            disabled={disabled || (locked !== null && !onSwitch)}
            title={
              locked
                ? onSwitch
                  ? `This session runs on ${cards?.[locked]?.label ?? locked}. Pick another harness to switch it, with a brief of the work so far.`
                  : `This thread runs on ${cards?.[locked]?.label ?? locked}.`
                : (blocker ?? `Harness: ${current?.label ?? value}`)
            }
          />
        }
      >
        {look === "inline" ? (
          // On the toolbar, a narrow panel shows the robot alone; the name
          // is in the title and in the list it opens.
          <>
            <HarnessIcon harness={value} size={16} />
            <span className="sr-only @md:not-sr-only @md:truncate">{current?.label ?? value}</span>
            <span className="hidden @md:contents">
              <PickerChevron look={look} />
            </span>
          </>
        ) : (
          <>
            <HarnessIcon harness={value} size={16} />
            <span className="truncate">{current?.label ?? value}</span>
            <PickerChevron look={look} />
          </>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading={locked && onSwitch ? "Switch this session to" : "Harness"}>
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
                      if (locked && onSwitch) {
                        if (id !== locked) onSwitch(id)
                      } else onChange(id)
                      setOpen(false)
                    }}
                  >
                    <HarnessIcon harness={id} size={16} />
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
            {onAccount && (() => {
              const own = (accounts ?? []).filter((a) => a.provider === value)
              if (own.length < 2) return null
              const current = currentProfileId ?? own.find((a) => a.isDefault)?.id
              return (
                <CommandGroup heading={locked ? "Move this session to account" : "Account"}>
                  {own.map((account) => {
                    const why = account.id === current ? null : accountBlocker(account)
                    return (
                      <CommandItem
                        key={account.id}
                        value={`account:${account.id}`}
                        data-checked={account.id === current}
                        disabled={why !== null}
                        title={why ?? undefined}
                        onSelect={() => {
                          if (account.id !== current) onAccount(account)
                          setOpen(false)
                        }}
                      >
                        <span className="min-w-0 truncate">{account.label}</span>
                        <span className="text-muted-foreground shrink-0 text-[10px] capitalize">{account.context}</span>
                        {why && <span className="text-muted-foreground ml-auto min-w-0 truncate text-[10px]">{why}</span>}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )
            })()}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
