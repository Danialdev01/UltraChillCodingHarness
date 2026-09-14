"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  formatPercent,
  formatResetsIn,
  primaryWindow,
  QUOTA_PROVIDERS,
  quotaTone,
  type SessionQuota,
  type SessionQuotas,
} from "@/lib/quotas"

/**
 * How often the rail asks again. The server caches each answer for a
 * minute, so asking more often would only be told the same thing.
 */
const POLL_MS = 60_000

/**
 * Three meters at the foot of the icon rail: how much of each harness's
 * session allowance is used.
 *
 * In the rail rather than the panel because the rail is the one column that
 * is on screen whether the sidebar is expanded or collapsed, and the point
 * of a quota meter is to be glanced at before starting a turn -- from
 * whatever page, in whatever state the sidebar was left. It is also why
 * the bars are the meter and the words are in a tooltip: the rail is icon
 * width, and a percent that needs reading is not a glance.
 *
 * Polled rather than pushed: the numbers move on the vendors' side, and
 * only while the tab is visible -- a background tab asking every minute
 * for a bar nobody can see is a request with no reader.
 */
export function QuotaRail() {
  const [quotas, setQuotas] = React.useState<SessionQuotas | null>(null)

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
    // Three columns across the rail rather than three rows down it: side by
    // side, each bar gets the rail's height to draw in instead of what is
    // left of its width after a label, and 28px shows a tenth where 12px
    // showed nothing. The tags sit under the bars, one glance to the three.
    <div className="flex items-end justify-center gap-1.5 px-1 py-2" aria-label="Session quotas">
      {QUOTA_PROVIDERS.map((provider) => (
        <QuotaBar
          key={provider.id}
          label={provider.label}
          tag={provider.tag}
          quota={quotas?.[provider.id] ?? null}
        />
      ))}
    </div>
  )
}

const FILL: Record<ReturnType<typeof quotaTone>, string> = {
  idle: "bg-transparent",
  normal: "bg-ucch-active",
  warn: "bg-amber-500",
  full: "bg-destructive",
}

function QuotaBar({
  label,
  tag,
  quota,
}: {
  label: string
  tag: string
  /** Null until the first answer arrives. */
  quota: SessionQuota | null
}) {
  const window = quota ? primaryWindow(quota) : null
  const percent = window?.usedPercent ?? null
  const tone = quotaTone(percent)
  // Not signed in is not a number, and a bar at zero would read as "plenty
  // left" -- so the whole row fades instead of the fill.
  const faded = quota?.status === "no_auth"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A div, not a button: a readout with nothing to press, the same as
          // the context meter. The tab stop would only be in the way of the
          // settings icon below it.
          <div
            className={`flex cursor-default flex-col items-center gap-1 ${faded ? "opacity-40" : ""}`}
            role="meter"
            aria-label={`${label} session quota`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent === null ? {} : { "aria-valuenow": Math.round(percent) })}
          />
        }
      >
        {/* Fills from the bottom, the way a gauge does. */}
        <div className="bg-muted flex h-7 w-1.5 items-end overflow-hidden rounded-full">
          <div
            className={`w-full rounded-full transition-[height] duration-500 ${FILL[tone]}`}
            style={{ height: `${percent ?? 0}%` }}
          />
        </div>
        <span className="text-muted-foreground font-mono text-[8px] leading-none tracking-tight select-none">
          {tag}
        </span>
      </TooltipTrigger>

      <TooltipContent side="right" className="flex-col items-start gap-0.5">
        <p className="font-medium">{label}</p>
        <QuotaWords quota={quota} />
      </TooltipContent>
    </Tooltip>
  )
}

/** The tooltip's lines: every window the vendor reported, or why there are none. */
function QuotaWords({ quota }: { quota: SessionQuota | null }) {
  if (!quota) return <p className="text-xs opacity-70">Checking…</p>
  if (quota.status === "no_auth") {
    return <p className="text-xs opacity-70">Not signed in. Connect it in Settings.</p>
  }
  if (quota.status === "unavailable") {
    return (
      <p className="text-xs opacity-70">
        Couldn&apos;t read the quota{quota.error ? `: ${quota.error}` : "."}
      </p>
    )
  }
  if (quota.windows.length === 0) {
    return <p className="text-xs opacity-70">No limits reported for this account.</p>
  }
  return (
    <>
      {quota.windows.map((window) => {
        const resets = formatResetsIn(window.resetsAt)
        return (
          <p key={window.id} className="text-xs tabular-nums">
            {window.label}: {formatPercent(window.usedPercent)} used
            {window.detail ? ` (${window.detail})` : ""}
            {resets ? ` · ${resets}` : ""}
          </p>
        )
      })}
    </>
  )
}
