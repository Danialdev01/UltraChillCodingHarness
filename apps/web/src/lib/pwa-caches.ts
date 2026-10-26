/**
 * Cache names the service worker (`app/sw.ts`) and the page share. Its own
 * module so the worker's bundle takes nothing else of the page's.
 */

/** The worker's copies of whole pages: one person's, so cleared on sign-out. */
export const PAGES_CACHE = "pages"
