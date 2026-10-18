"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"

/** A section's transient outcome: what went wrong, or that it worked. */
export function useOutcome() {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  // The confirmation clears itself; an error stays until the next attempt,
  // because it is the thing the reader has to act on.
  React.useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), 4000)
    return () => clearTimeout(timer)
  }, [done])

  const run = React.useCallback(async (work: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      setDone(await work())
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, done, run }
}

export function Outcome({ error, done }: { error: string | null; done: string | null }) {
  if (!error && !done) return null
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-sm ${error ? "text-destructive" : "text-ucch-active"}`}>
      {!error && <CheckIcon className="size-4 shrink-0" />}
      {error ?? done}
    </p>
  )
}
