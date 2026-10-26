"use client"

import * as React from "react"

import { syncServiceWorker } from "@/lib/pwa"

/** Registers the service worker once the page has loaded; see `lib/pwa.ts`. */
export function ServiceWorker() {
  React.useEffect(() => {
    const sync = () => void syncServiceWorker().catch(() => {})
    // After `load`, so the worker's install never competes with the page's own requests.
    if (document.readyState === "complete") sync()
    else window.addEventListener("load", sync, { once: true })
    return () => window.removeEventListener("load", sync)
  }, [])
  return null
}
