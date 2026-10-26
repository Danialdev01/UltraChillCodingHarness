/// <reference lib="webworker" />
import type { PrecacheEntry, RouteMatchCallbackOptions, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

import { PAGES_CACHE } from "@/lib/pwa";

/**
 * The service worker, built only when `NEXT_PUBLIC_PWA=1` (next.config.ts).
 *
 * It exists for two things: an installed app that opens without waiting on
 * the network for files it already has, and a page instead of the browser's
 * error when the server cannot be reached. It is not an offline mode -- the
 * app's data is live and goes nowhere near this:
 *
 *   /_next/static/*      cache-first: the names change with the bytes
 *   /file-icons/svg/*    stale-while-revalidate
 *   RSC fetches          network-only: the router's own cache handles these
 *   page loads           network-first, 3 s; then this browser's copy of
 *                        that page; then /offline
 *   /api, /ws, /collab   untouched, as is every other origin (preview hosts)
 *
 * Precached at install: the stylesheets, the fonts, the runtime chunks and
 * /offline (see `manifestTransforms` in next.config.ts). The rest of the
 * shell's chunks are handed over by the page that registered this, once it
 * is in control (`components/service-worker.tsx`), so they need not be
 * listed here by name.
 *
 * A new build waits (`skipWaiting: false`) until the page says to take over,
 * which is the update prompt's job, so a tab never has its chunks swapped
 * underneath it mid-session.
 */

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const DAY = 24 * 60 * 60;

/** The app's own requests, minus those that are never the worker's business. */
function ours({ url }: RouteMatchCallbackOptions): boolean {
  return url.origin === self.location.origin && !/^\/(?:api|ws|collab)(?:\/|$)/.test(url.pathname);
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: (options) => ours(options) && options.request.headers.get("RSC") === "1",
      handler: new NetworkOnly(),
    },
    {
      matcher: (options) => ours(options) && options.url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({
        cacheName: "next-static",
        plugins: [new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 30 * DAY })],
      }),
    },
    {
      matcher: (options) => ours(options) && options.url.pathname.startsWith("/file-icons/svg/"),
      handler: new StaleWhileRevalidate({
        cacheName: "file-icons",
        plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * DAY })],
      }),
    },
    {
      matcher: (options) => ours(options) && options.request.mode === "navigate",
      handler: new NetworkFirst({
        // Signed-out pages included: the sign-in page is static anyway.
        // Cleared on sign-out (`nav-user.tsx`), being one person's pages.
        cacheName: PAGES_CACHE,
        networkTimeoutSeconds: 3,
        plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 7 * DAY })],
      }),
    },
  ],
  fallbacks: {
    entries: [{ url: "/offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

serwist.addEventListeners();
