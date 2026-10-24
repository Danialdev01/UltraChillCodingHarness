"use client"

import * as React from "react"

import { flushVitals, reportVital, vitalsEnabled } from "@/lib/vitals"

/**
 * Reports the Core Web Vitals of each page load (lib/vitals.ts sends them).
 *
 * They are the load's, so they carry the path the page was loaded on, not
 * whatever page a soft navigation has reached by the time one is final --
 * LCP and CLS are only settled when the tab is hidden. The queue is sent
 * then too, since a hidden tab may never run again.
 *
 * `web-vitals` is fetched after hydration rather than bundled into every
 * route's first load; its observers read the buffered entries, so nothing
 * that happened before it arrived is missed.
 */
export function VitalsReporter() {
  React.useEffect(() => {
    if (!vitalsEnabled()) return
    const landed = location.pathname
    let stopped = false
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushVitals()
    }
    void import("web-vitals").then(({ onCLS, onINP, onLCP, onTTFB }) => {
      if (stopped) return
      const report = (metric: { name: "CLS" | "INP" | "LCP" | "TTFB"; value: number }) =>
        reportVital(metric.name, metric.value, landed)
      onLCP(report)
      onINP(report)
      onCLS(report)
      onTTFB(report)
      // Added after web-vitals' own listeners, so its final values are
      // queued by the time this sends.
      document.addEventListener("visibilitychange", onHidden)
      window.addEventListener("pagehide", flushVitals)
    })
    return () => {
      stopped = true
      document.removeEventListener("visibilitychange", onHidden)
      window.removeEventListener("pagehide", flushVitals)
    }
  }, [])
  return null
}
