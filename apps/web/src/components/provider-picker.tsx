"use client"

import * as React from "react"

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

// The same shape as the effort select beside it.
const SELECT =
  "border-input bg-background focus-visible:ring-ring h-8 max-w-32 truncate rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:opacity-60 @md:max-w-52"

/**
 * Which backend answers the next message.
 *
 * A plain select: three entries, and the interesting part is which ones are
 * greyed out and why -- the option's title says. Once a thread has run it is
 * bound to its provider and the select locks, because the server would
 * refuse a switch and a control that looks live but is not is worse than one
 * that says so.
 */
export function ProviderSelect({
  providers,
  value,
  locked,
  onChange,
  disabled,
}: {
  providers: ProvidersState
  value: ProviderId
  /** The thread's binding, when it has one. */
  locked: ProviderId | null
  onChange: (id: ProviderId) => void
  disabled?: boolean
}) {
  const cards = providers.cards
  const current = cards?.[value]
  const blocker = current ? providerBlocker(current) : null

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ProviderId)}
      disabled={disabled || locked !== null}
      aria-label="Harness"
      title={
        locked
          ? `This thread runs on ${cards?.[locked]?.label ?? locked}. Clear the context to switch.`
          : (blocker ?? "Which harness answers")
      }
      className={SELECT}
    >
      {ORDER.map((id) => {
        const card = cards?.[id]
        const why = card ? providerBlocker(card) : id === "native" ? null : "Checking…"
        return (
          <option key={id} value={id} disabled={why !== null && id !== value} title={why ?? undefined}>
            {card?.label ?? id}
            {why ? ` (${why})` : ""}
          </option>
        )
      })}
    </select>
  )
}
