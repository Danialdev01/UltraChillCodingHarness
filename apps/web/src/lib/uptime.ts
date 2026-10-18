import * as React from "react"

/** How long a session has been up, in its coarsest unit: "5m", "3h", "2d". */
export function uptime(createdAt: string | undefined, now: number | null): string {
  const then = createdAt ? Date.parse(createdAt) : Number.NaN
  if (now === null || Number.isNaN(then)) return ""
  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The time, stamped after mount and once a minute: null on the server and
 * the first client render, so the two agree, and ticking after that so the
 * uptimes do not freeze.
 */
export function useMinuteClock(): number | null {
  const [now, setNow] = React.useState<number | null>(null)
  React.useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
