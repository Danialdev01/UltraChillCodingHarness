/**
 * Real-user timings, reported to `POST /api/metrics/vitals`.
 *
 * The server keeps nothing but histograms by route template (`/metrics`), so
 * what goes out is a name, a number and the path it was measured on -- no
 * user, no session, no content. Entries are queued and sent in batches with
 * `navigator.sendBeacon`, which survives the page being closed: on a timer,
 * when the queue fills, and when the tab is hidden.
 *
 * Sampling is per page load: `NEXT_PUBLIC_VITALS_SAMPLE_RATE` (0 to 1,
 * default 1) is the share of loads that report anything at all.
 *
 * Besides the Core Web Vitals (components/vitals-reporter.tsx), the app marks
 * its own moments:
 *
 *   nav-skeleton       a click on a link -> the new page (or its skeleton)
 *                      painted; lib/view-transitions.tsx
 *   nav-content        the same click -> nothing in <main> is a skeleton
 *   frame-to-paint     a streamed delta's arrival -> the paint of the chat
 *                      that shows it; components/project-chat.tsx
 *   keystroke-to-echo  a key typed into a terminal -> the paint after its
 *                      echo; components/terminal-view.tsx
 */

export type VitalName =
  | "LCP"
  | "INP"
  | "CLS"
  | "TTFB"
  | "nav-skeleton"
  | "nav-content"
  | "frame-to-paint"
  | "keystroke-to-echo"

export interface Vital {
  name: VitalName
  /** Milliseconds; CLS is its own unitless score. */
  value: number
  path: string
}

const ENDPOINT = "/api/metrics/vitals"
const FLUSH_MS = 10_000
/** The server takes at most this many per batch. */
export const MAX_BATCH = 50

function sampleRate(): number {
  const rate = Number(process.env.NEXT_PUBLIC_VITALS_SAMPLE_RATE ?? 1)
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1
}

let sampled: boolean | null = null
let queue: Vital[] = []
let timer: ReturnType<typeof setTimeout> | null = null

/** Whether this page load reports; decided once. */
export function vitalsEnabled(): boolean {
  if (typeof window === "undefined") return false
  sampled ??= Math.random() < sampleRate()
  return sampled
}

/** Queues one timing, measured on `path` (the current page by default). */
export function reportVital(name: VitalName, value: number, path = location.pathname): void {
  if (!vitalsEnabled() || !Number.isFinite(value) || value < 0) return
  queue.push({ name, value: Math.round(value * 1000) / 1000, path })
  if (queue.length >= MAX_BATCH) flushVitals()
  else timer ??= setTimeout(flushVitals, FLUSH_MS)
}

/** Sends whatever is queued. */
export function flushVitals(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  while (queue.length > 0) {
    const batch = queue.slice(0, MAX_BATCH)
    queue = queue.slice(MAX_BATCH)
    const body = new Blob([JSON.stringify({ vitals: batch })], { type: "application/json" })
    // A full beacon queue is dropped rather than retried: these are samples.
    if (typeof navigator.sendBeacon === "function") navigator.sendBeacon(ENDPOINT, body)
    else void fetch(ENDPOINT, { method: "POST", body, keepalive: true, credentials: "include" }).catch(() => {})
  }
}

/**
 * Calls `done` once the frame after this one has been painted: a task posted
 * from inside an animation frame runs after that frame's paint.
 */
export function afterNextPaint(done: () => void): void {
  requestAnimationFrame(() => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => done()
    channel.port2.postMessage(null)
  })
}

// -- Navigation -----------------------------------------------------------------

/** How long nav-content waits for the skeletons to go before giving up. */
const CONTENT_TIMEOUT_MS = 15_000

let navigation: { path: string; at: number } | null = null

/** A link was clicked: the clock starts for `href`. */
export function markNavigationStart(href: string): void {
  if (!vitalsEnabled()) return
  const path = new URL(href, location.href).pathname
  // A link to the page on screen changes nothing, so nothing commits for it.
  navigation = path === location.pathname ? null : { path, at: performance.now() }
}

/**
 * The URL now shows `pathname`, in a commit not yet painted. When it is the
 * page a click asked for, the paint after this commit is nav-skeleton, and
 * the first of two frames running with no skeleton in <main> is nav-content
 * (two, so a skeleton swapped for another does not count as done).
 */
export function markNavigationCommit(pathname: string): void {
  const started = navigation
  if (!started || started.path !== pathname) return
  navigation = null
  // A click whose navigation never landed, met again by a later visit.
  if (performance.now() - started.at > CONTENT_TIMEOUT_MS) return
  afterNextPaint(() => {
    reportVital("nav-skeleton", performance.now() - started.at, pathname)
    let quiet = 0
    let contentAt = 0
    const check = () => {
      const now = performance.now()
      if (now - started.at > CONTENT_TIMEOUT_MS || location.pathname !== pathname) return
      const main = document.querySelector("main") ?? document.body
      if (main.querySelector('[data-slot="skeleton"]')) quiet = 0
      else if (++quiet === 1) contentAt = now
      if (quiet >= 2) reportVital("nav-content", contentAt - started.at, pathname)
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}
