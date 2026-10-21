"use client"

import * as React from "react"

import { BootFrame } from "@/components/boot-frame"
import { useBootProgress } from "@/lib/boot-progress"

/** Fade-out, in step with `BootFrame`'s transition. */
const FADE_MS = 300

/**
 * However the load goes -- the shell failed to render, its script never ran
 * -- the boot screen never outstays this. The load itself opens the app well
 * before (`GATE_MS` in `route-warmup.tsx`).
 */
const NEVER_LONGER_MS = 9000

/**
 * The boot screen over a signed-in first load: drawn by the app layout, in
 * the page's first bytes, when this browser session has not booted yet
 * (`lib/boot-cookie.ts`). The shell renders beneath it as usual; its
 * `RouteWarmup` loads the app and reports here, and says when to open.
 */
export function BootGate() {
  const { progress, label, done } = useBootProgress()
  const [expired, setExpired] = React.useState(false)
  const [gone, setGone] = React.useState(false)
  const leaving = done || expired

  React.useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), NEVER_LONGER_MS)
    return () => window.clearTimeout(timer)
  }, [])

  React.useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setGone(true), FADE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  if (gone) return null
  return <BootFrame progress={leaving ? 1 : progress} label={label} leaving={leaving} />
}
