"use client"

import * as React from "react"

import { HarnessIcon } from "@/components/harness-icon"
import { KindTile } from "@/components/model-key-settings"
import { PickerChevron, pickerTrigger, type ModelSource, type PickerLook } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  accountStatus,
  fetchAccounts,
  fetchProviders,
  PROVIDERS_CHANGED,
  providerBlocker,
  refreshProviders,
  type AgentAccount,
  type ProviderCard,
  type ProviderId,
} from "@/lib/providers-api"
import { KIND_NAMES } from "@/lib/model-keys"
import { Loader2Icon, RefreshCwIcon } from "lucide-react"

export interface ProvidersState {
  cards: Record<ProviderId, ProviderCard> | null
  defaultProvider: ProviderId | null
  /** Looks for newly installed CLIs on the server; absent where nothing can. */
  refresh?: () => Promise<void>
}

/**
 * The provider cards, fetched on mount and again whenever any page refreshes
 * them (`PROVIDERS_CHANGED`), so a chat open in another tab hears about a
 * Claude installed since it loaded. Null until they land.
 */
export function useProviders(): ProvidersState {
  const [state, setState] = React.useState<Omit<ProvidersState, "refresh">>({ cards: null, defaultProvider: null })
  const [generation, setGeneration] = React.useState(0)
  React.useEffect(() => {
    const bump = () => setGeneration((g) => g + 1)
    window.addEventListener(PROVIDERS_CHANGED, bump)
    return () => window.removeEventListener(PROVIDERS_CHANGED, bump)
  }, [])
  const refresh = React.useCallback(async () => {
    // The event this fires refetches every picker, this one included.
    await refreshProviders()
  }, [])
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
  }, [generation])
  return React.useMemo(() => ({ ...state, refresh }), [state, refresh])
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

/** A named key's tile at the size of a harness icon. */
const KEY_TILE = "size-4 rounded-[4px] [&_svg]:size-2.5 [&>span]:text-[7px]"

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
  modelKeys,
  currentKeyId,
  onModelKey,
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
  /**
   * The named keys from Settings -> AI Provider -> Custom. Each is listed as
   * a harness of its own, by the name it was given, in place of Custom:
   * picking one is Custom with the model moved onto that key.
   */
  modelKeys?: ModelSource[]
  /** The key the current model bills, when it names one. */
  currentKeyId?: string | null
  onModelKey?: (keyId: string) => void
  disabled?: boolean
  look?: PickerLook
}) {
  const [open, setOpen] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const cards = providers.cards
  // Offered only when it could help: some harness is missing on the server.
  const missing = cards !== null && ORDER.some((id) => id !== "native" && cards[id] && !cards[id].installed)
  const current = cards?.[value]
  const blocker = current ? providerBlocker(current) : null
  const keys = onModelKey ? (modelKeys ?? []) : []
  // Under Custom, the key in use stands in for the harness: it goes by the
  // name it was given, as Claude Code and Codex go by theirs.
  const currentKey = value === "native" ? keys.find((k) => k.id === currentKeyId) : undefined
  const label = currentKey?.name ?? current?.label ?? value

  /** Custom, billing `keyId`: the key first, so the harness's next turn is on it. */
  function chooseKey(keyId: string) {
    onModelKey?.(keyId)
    if (locked && onSwitch) {
      if (locked !== "native") onSwitch("native")
    } else if (value !== "native") onChange("native")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            {...pickerTrigger(look, look === "inline" ? "text-muted-foreground shrink-0 @lg:shrink" : "w-36")}
            role="combobox"
            aria-expanded={open}
            aria-label="Harness"
            disabled={disabled || (locked !== null && !onSwitch)}
            title={
              locked
                ? onSwitch
                  ? `This session runs on ${cards?.[locked]?.label ?? locked}. Pick another harness to switch it, with a brief of the work so far.`
                  : `This thread runs on ${cards?.[locked]?.label ?? locked}.`
                : (blocker ?? `Harness: ${currentKey ? `${current?.label ?? value} on ${currentKey.name}` : label}`)
            }
          />
        }
      >
        {look === "inline" ? (
          // On the toolbar, a narrow panel shows the robot alone; the name
          // is in the title and in the list it opens.
          <>
            {currentKey ? <KindTile kind={currentKey.kind} className={KEY_TILE} /> : <HarnessIcon harness={value} size={16} />}
            <span className="sr-only @lg:not-sr-only @lg:truncate">{label}</span>
            <span className="hidden @lg:contents">
              <PickerChevron look={look} />
            </span>
          </>
        ) : (
          <>
            {currentKey ? <KindTile kind={currentKey.kind} className={KEY_TILE} /> : <HarnessIcon harness={value} size={16} />}
            <span className="truncate">{label}</span>
            <PickerChevron look={look} />
          </>
        )}
      </PopoverTrigger>

      {/* As wide as its rows: names are short, and only a blocked row's reason needs the room. */}
      <PopoverContent className="w-max min-w-48 max-w-72 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading={locked && onSwitch ? "Switch this session to" : "Harness"}>
              {ORDER.map((id) => {
                const card = cards?.[id]
                const why = card ? providerBlocker(card) : id === "native" ? null : "Checking…"
                // Custom with named keys: one row per key, by its name, in
                // place of the one Custom row. Picking a key is picking Custom
                // and billing that key, in one go.
                if (id === "native" && keys.length > 0) {
                  return keys.map((key) => {
                    const checked = value === "native" && key.id === currentKeyId
                    return (
                      <CommandItem
                        key={`key:${key.id}`}
                        value={`key:${key.id}`}
                        data-checked={checked}
                        disabled={why !== null && value !== "native"}
                        title={why ?? `${card?.label ?? "Custom"} on ${key.name} (${KIND_NAMES[key.kind]})`}
                        onSelect={() => {
                          if (!checked) chooseKey(key.id)
                          setOpen(false)
                        }}
                      >
                        <KindTile kind={key.kind} className={KEY_TILE} />
                        <span className="min-w-0 truncate">{key.name}</span>
                        {why && (
                          <span className="text-muted-foreground ml-auto min-w-0 truncate text-[10px]">{why}</span>
                        )}
                      </CommandItem>
                    )
                  })
                }
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
            {missing && providers.refresh && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="refresh-providers"
                    disabled={refreshing}
                    title="Look for a Claude Code or Codex installed since the server started"
                    onSelect={() => {
                      setRefreshing(true)
                      void providers.refresh!()
                        .catch(() => {})
                        .finally(() => setRefreshing(false))
                    }}
                  >
                    {refreshing ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
                    <span>{refreshing ? "Refreshing…" : "Refresh providers"}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
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
