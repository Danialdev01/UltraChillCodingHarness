/**
 * The page's side of the service worker (`app/sw.ts`).
 *
 * The worker is built only when `NEXT_PUBLIC_PWA=1`, and registered only in
 * a production build with that flag. With the flag off, any worker an
 * earlier build registered is removed: from this page at once, and through
 * the kill-switch `sw.js` the server sends in its place (web-proxy.ts) for
 * a tab that never runs this code again.
 */

/** The worker's copies of whole pages: one person's, so cleared on sign-out. */
export const PAGES_CACHE = "pages"

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
  return registration
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
