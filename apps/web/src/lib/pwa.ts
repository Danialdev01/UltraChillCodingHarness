/**
 * The page's side of the service worker (`app/sw.ts`).
 *
 * The worker is built only when `NEXT_PUBLIC_PWA=1`, and registered only in
 * a production build with that flag. With the flag off, any worker an
 * earlier build registered is removed: from this page at once, and through
 * the kill-switch `sw.js` the server sends in its place (web-proxy.ts) for
 * a tab that never runs this code again.
 */

import { reportWaitingWorker } from "@/lib/app-update"
import { PAGES_CACHE } from "@/lib/pwa-caches"

export const PWA_ENABLED = process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_PWA === "1"

/** Registers the worker, or removes one left by a build that had it. */
export async function syncServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const container = globalThis.navigator?.serviceWorker
  if (!container) return null
  if (!PWA_ENABLED) {
    for (const registration of await container.getRegistrations()) await registration.unregister()
    return null
  }
  // `updateViaCache: "none"`: the browser checks sw.js itself on every load,
  // never an HTTP-cached copy, so a deploy is noticed the next time a page opens.
  const registration = await container.register("/sw.js", { scope: "/", updateViaCache: "none" })
  void handOverLoadedFiles(container)
  watchForWaiting(registration)
  return registration
}

/**
 * Reports a new build's worker once it is installed and waiting -- already,
 * or later in this tab's life -- so the update toast can offer it. Only
 * when another worker is in control: the very first install has nothing to
 * replace, and takes over on its own (`clientsClaim`).
 */
function watchForWaiting(registration: ServiceWorkerRegistration): void {
  const container = navigator.serviceWorker
  const check = () => {
    if (registration.waiting && container.controller) reportWaitingWorker(registration.waiting)
  }
  check()
  registration.addEventListener("updatefound", () => {
    registration.installing?.addEventListener("statechange", check)
  })
}

/**
 * The browser's offer to install the app, held until the person asks for it
 * from the user menu. It fires once, early, and is gone if missed, so it is
 * caught as soon as this module loads.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

let installPrompt: InstallPromptEvent | null = null
const installListeners = new Set<() => void>()

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Without this the browser shows its own mini-infobar.
    event.preventDefault()
    installPrompt = event as InstallPromptEvent
    for (const listener of installListeners) listener()
  })
  window.addEventListener("appinstalled", () => {
    installPrompt = null
    for (const listener of installListeners) listener()
  })
}

export function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}

/** For `useSyncExternalStore`: whether the browser has offered an install. */
export function canInstall(): boolean {
  return installPrompt !== null
}

/** Shows the browser's install dialog. The offer is spent either way. */
export async function promptInstall(): Promise<void> {
  const event = installPrompt
  if (!event) return
  installPrompt = null
  for (const listener of installListeners) listener()
  await event.prompt()
  await event.userChoice.catch(() => {})
}

/**
 * Files handed to the worker to keep, so neither the precache nor anything
 * else has to name them chunk by chunk:
 *
 * - what this page already loaded before the worker was in control -- the
 *   shell's chunks and stylesheets -- so the next load finds them;
 * - every chunk /offline itself loads. The worker precaches the page's HTML,
 *   but a page served with no server must also hydrate, or its recent
 *   projects never appear; its chunks are read from that HTML.
 */
async function handOverLoadedFiles(container: ServiceWorkerContainer): Promise<void> {
  const ready = await container.ready
  const ours = (name: string) => {
    const url = new URL(name, location.origin)
    return url.origin === location.origin && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/file-icons/svg/"))
  }
  const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
  const offline = await fetch("/offline")
    .then((response) => (response.ok ? response.text() : ""))
    // Script tags name them in full; the RSC payload inline names the rest
    // of the page's chunks without the `/_next/` prefix.
    .then((html) => [...html.matchAll(/(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\s\\]+/g)].map(([path]) => (path.startsWith("/") ? path : `/_next/${path}`)))
    .catch(() => [])
  const urls = [...new Set([...loaded, ...offline].filter(ours))]
  if (urls.length > 0) ready.active?.postMessage({ type: "CACHE_URLS", payload: { urlsToCache: urls } })
}

/** Forgets the worker's copies of this person's pages. */
export async function clearPageCache(): Promise<void> {
  try {
    await globalThis.caches?.delete(PAGES_CACHE)
  } catch {
    // No Cache Storage (an insecure origin): there were no copies.
  }
}
