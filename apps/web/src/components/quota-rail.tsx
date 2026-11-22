"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { GaugeIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { qk } from "@/lib/query-keys"
import {
  formatPercent,
  formatResetsIn,
  primaryWindow,
  QUOTA_PROVIDERS,
  quotaTone,
  type QuotaProvider,
  type SessionQuota,
  type SessionQuotas,
} from "@/lib/quotas"

/**
 * How often the rail asks again. The server caches each answer for a
 * minute, so asking more often would only be told the same thing.
 */
const POLL_MS = 60_000

/**
 * The usage gauge at the foot of the icon rail: how much of each harness's
 * session allowance is used, as three thin bars with the numbers on hover.
 *
 * In the rail rather than the panel because the rail is the one column that
 * is on screen whether the sidebar is expanded or collapsed, and the point
 * of a quota meter is to be glanced at before starting a turn -- from
 * whatever page, in whatever state the sidebar was left. It is also why
 * the bars are the meter and the words are in a hover card: the rail is
 * icon width, and a percent that needs reading is not a glance.
 *
 * Polled rather than pushed: the numbers move on the vendors' side, and
 * only while the tab is visible -- a background tab asking every minute
 * for a bar nobody can see is a request with no reader.
 */
export function QuotaRail() {
  // The last reading, from the client cache, so the bars are filled from
  // the first frame rather than after the first poll.
  const queryClient = useQueryClient()
  const [quotas, setQuotasState] = React.useState<SessionQuotas | null>(
    () => queryClient.getQueryData<SessionQuotas>(qk.quotas.all) ?? null,
  )
  const setQuotas = React.useCallback(
    (next: SessionQuotas) => {
      setQuotasState(next)
      queryClient.setQueryData(qk.quotas.all, next)
    },
    [queryClient],
  )

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const load = async () => {
      try {
        const response = await fetch("/api/account/quotas", { credentials: "include" })
        if (!response.ok || cancelled) return
        setQuotas((await response.json()) as SessionQuotas)
      } catch {
        // Unreachable is the same as not-yet-loaded: the bars stay empty and
        // the tooltip says nothing has been measured. The next tick retries.
      }
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    const tick = async () => {
      if (document.visibilityState === "visible") await load()
      if (!cancelled) schedule()
    }
    // Coming back to the tab asks at once rather than waiting out the
    // remainder of a tick that started while nobody was looking.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick()
    }

    // The first look is unconditional: a tab opened in the background should
    // have its bars filled by the time it is looked at, not start then.
    void load().then(() => {
      if (!cancelled) schedule()
    })
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return (
    // One small gauge at the foot of the rail: three thin bars, one per
    // harness, and the words behind it in a card that opens on hover or
    // focus. The same in both themes. The user chose this over the light
    // guideline's horizontal labelled bars (§5.12), and the card is where
    // the readable labels live, reachable by keyboard as well as pointer.
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        delay={80}
        closeDelay={120}
        render={
          // A div, not a button: a readout with nothing to press. Still a
          // tab stop, so the card is not for mouse users only.
          <div
            role="group"
            tabIndex={0}
            aria-label="Session quotas"
            className="border-sidebar-border hover:border-border focus-visible:ring-focus-ring flex w-10 shrink-0 cursor-default flex-col items-center gap-1.5 rounded-[9px] border pt-1.5 pb-1 transition-colors duration-150 outline-none focus-visible:ring-2"
          />
        }
      >
        <span className="flex items-end gap-1">
          {QUOTA_PROVIDERS.map((provider) => (
            <QuotaBar
              key={provider.id}
              id={provider.id}
              label={provider.label}
              quota={quotas?.[provider.id] ?? null}
            />
          ))}
        </span>
        <GaugeIcon className="text-text-subtle size-3" aria-hidden />
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="right" align="end" sideOffset={8} className="isolate z-50">
          <TooltipPrimitive.Popup className="bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 pointer-events-none w-48 rounded-lg p-2.5 shadow-lg ring-1">
            <p className="text-text-subtle mb-1.5 text-2xs">Usage this period</p>
            <ul className="flex flex-col">
              {QUOTA_PROVIDERS.map((provider) => (
                <QuotaRow
                  key={provider.id}
                  id={provider.id}
                  label={provider.label}
                  quota={quotas?.[provider.id] ?? null}
                />
              ))}
            </ul>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/**
 * Each harness's colour, from the theme's note palette: orange, green and
 * purple keep their hue in both modes, which the chart tokens do not.
 */
const PROVIDER_FILL: Record<QuotaProvider, string> = {
  claude: "bg-(--ucch-note-orange)",
  codex: "bg-(--ucch-note-green)",
  native: "bg-(--ucch-note-purple)",
}

/** Nearly out wins over the harness's colour: amber, then red. */
function fillClass(id: QuotaProvider, tone: ReturnType<typeof quotaTone>): string {
  if (tone === "warn") return "bg-warning"
  if (tone === "full") return "bg-destructive"
  if (tone === "idle") return "bg-transparent"
  return PROVIDER_FILL[id]
}

/** What one quota says, for the meter's `aria-valuetext` and the card. */
function describe(quota: SessionQuota | null): { percent: number | null; text: string; resets: string } {
  const window = quota ? primaryWindow(quota) : null
  const percent = window?.usedPercent ?? null
  const resets = window ? formatResetsIn(window.resetsAt) : ""
  const text = !quota
    ? "Checking"
    : quota.status === "no_auth"
      ? "Not signed in"
      : quota.status === "unavailable"
        ? "Unavailable"
        : percent === null
          ? "No limits"
          : formatPercent(percent)
  return { percent, text, resets }
}

function QuotaBar({ id, label, quota }: { id: QuotaProvider; label: string; quota: SessionQuota | null }) {
  const { percent, text, resets } = describe(quota)
  const tone = quotaTone(percent)
  // Not signed in is not a number, and a bar at zero would read as "plenty
  // left", so the track goes hollow and dashed instead.
  const signedOut = quota?.status === "no_auth"
  return (
    <span
      role="meter"
      aria-label={`${label} session quota`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={percent === null ? text : `${text} used${resets ? `, ${resets}` : ""}`}
      {...(percent === null ? {} : { "aria-valuenow": Math.round(percent) })}
      className={cn(
        "flex h-9 w-[5px] items-end overflow-hidden rounded-full",
        signedOut ? "border-border-strong border border-dashed" : "bg-muted ring-border ring-1 ring-inset",
        // Not measured yet: the empty track pulses, the way a skeleton does.
        !quota && "motion-safe:animate-pulse",
      )}
    >
      <span
        className={cn(
          "block h-(--quota) w-full rounded-full transition-[height] duration-500",
          fillClass(id, tone),
          // A high bar also gets a cap in the ink colour, so "nearly out"
          // does not rest on colour alone.
          (tone === "warn" || tone === "full") && "border-foreground border-t-2",
        )}
        style={{ "--quota": `${Math.min(100, percent ?? 0)}%` } as React.CSSProperties}
      />
    </span>
  )
}

function QuotaRow({ id, label, quota }: { id: QuotaProvider; label: string; quota: SessionQuota | null }) {
  const { text, resets } = describe(quota)
  return (
    <li className="flex flex-col py-0.5 text-xs">
      <span className="flex items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_FILL[id])} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-muted-foreground tabular-nums">{text}</span>
      </span>
      {resets && <span className="text-text-subtle pl-3.5 text-2xs tabular-nums">{resets}</span>}
    </li>
  )
}
