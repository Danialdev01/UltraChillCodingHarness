"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { qk } from "@/lib/query-keys"
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
    // Three columns across the rail rather than three rows down it: side by
    // side, each bar gets the rail's height to draw in instead of what is
    // left of its width after a label, and 28px shows a tenth where 12px
    // showed nothing. The tags sit under the bars, one glance to the three.
    //
    // Light mode follows the light theme guideline (§5.12) instead: a
    // "Usage" group label, then one horizontal bar per harness with its tag
    // as a readable label above it -- no tiny captions under bare bars.
    <div
      className="light:flex-col light:items-stretch light:gap-2 light:px-1.5 flex items-end justify-center gap-1.5 px-1 py-2"
      role="group"
      aria-label="Session quotas"
    >
      <span className="light:block light:-mx-1.5 text-muted-foreground hidden text-center text-[12px] leading-none font-semibold tracking-[0.04em] uppercase select-none">
        Usage
      </span>
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
  normal: "bg-ucch-active light:bg-primary",
  warn: "bg-warning",
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
  // left" -- so the track goes hollow and dashed instead. Fading the whole
  // row did the same job but took the tag below a readable contrast.
  const signedOut = quota?.status === "no_auth"
  const resets = window ? formatResetsIn(window.resetsAt) : ""
  const valueText = !quota
    ? "Checking"
    : signedOut
      ? "Not signed in"
      : percent === null
        ? "No limits reported"
        : `${formatPercent(percent)} used${resets ? `, ${resets}` : ""}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A div, not a button: a readout with nothing to press, the same as
          // the context meter. Still a tab stop, so the words in the tooltip
          // are not for mouse users only.
          <div
            className="light:items-stretch light:flex-col-reverse flex cursor-default flex-col items-center gap-1 rounded-sm focus-visible:outline-offset-0"
            role="meter"
            tabIndex={0}
            aria-label={`${label} session quota`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={valueText}
            {...(percent === null ? {} : { "aria-valuenow": Math.round(percent) })}
          />
        }
      >
        {/* Fills from the bottom, the way a gauge does. The outline keeps the
            track visible at 3:1 against the rail; a high bar also gets a cap
            in the ink colour, so "nearly out" does not rest on red alone. */}
        <div
          className={cn(
            "light:h-1.5 light:w-full light:items-stretch flex h-7 w-1.5 items-end overflow-hidden rounded-full",
            signedOut
              ? "border-border-strong border border-dashed"
              : "bg-muted ring-border-strong light:bg-border light:ring-0 ring-1",
            // Not measured yet: the empty track pulses, the way a skeleton does.
            !quota && "animate-pulse",
          )}
        >
          <div
            className={cn(
              "light:h-full light:w-(--quota) light:transition-[width] h-(--quota) w-full rounded-full transition-[height] duration-500",
              FILL[tone],
              (tone === "warn" || tone === "full") &&
                "border-foreground light:border-t-0 light:border-r-2 border-t-2",
            )}
            style={{ "--quota": `${percent ?? 0}%` } as React.CSSProperties}
          />
        </div>
        <span className="text-muted-foreground light:text-foreground light:text-[12.5px] light:font-semibold light:tracking-normal light:text-left font-mono text-[10px] leading-none tracking-tight select-none">
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
  if (!quota) return <p className="text-xs">Checking…</p>
  if (quota.status === "no_auth") {
    return <p className="text-xs">Not signed in. Connect it in Settings.</p>
  }
  if (quota.status === "unavailable") {
    return (
      <p className="text-xs">
        Couldn&apos;t read the quota{quota.error ? `: ${quota.error}` : "."}
      </p>
    )
  }
  if (quota.windows.length === 0) {
    return <p className="text-xs">No limits reported for this account.</p>
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
