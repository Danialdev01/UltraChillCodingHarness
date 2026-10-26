/**
 * Whether a newer build than the one running in this tab is out, and what
 * taking it means. Three things can say so:
 *
 * - the socket's `ready` frame, which carries the server's build id, on
 *   every (re)connect -- a deploy restarts the server, so the reconnect
 *   after one brings the news;
 * - the bootstrap, which carries it too, refetched when the tab comes back;
 * - a service worker that has installed a new build and is waiting
 *   (`lib/pwa.ts`), when the PWA flag is on.
 *
 * Nothing reloads by itself: the tab may hold a half-typed message. The
 * update toast (`components/update-toast.tsx`) asks, and `takeUpdate` does it.
 * Without a build id on both sides (development, an image built without one)
 * there is nothing to compare, and nothing is offered.
 */

type Listener = () => void

let newerBuild: string | null = null
let waitingWorker: ServiceWorker | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** For `useSyncExternalStore`. */
export function updateAvailable(): boolean {
  return newerBuild !== null || waitingWorker !== null
}

/** Whether `serverBuild` is a different build from this tab's. */
export function isOtherBuild(serverBuild: string | undefined | null, running = process.env.NEXT_PUBLIC_BUILD_ID): boolean {
  return Boolean(running && serverBuild && serverBuild !== running)
}

/** The server said which build it runs. */
export function reportServerBuild(serverBuild: string | undefined | null): void {
  if (!isOtherBuild(serverBuild) || newerBuild === serverBuild) return
  newerBuild = serverBuild!
  emit()
}

/** A service worker with a new build is installed and waiting for this page's word. */
export function reportWaitingWorker(worker: ServiceWorker): void {
  if (waitingWorker === worker) return
  waitingWorker = worker
  emit()
}

/**
 * Loads the new build. A waiting worker is told to take over first and the
 * page reloads once it has, so the reload is served by the new one; without
 * one, a reload is all there is to it.
 */
export function takeUpdate(): void {
  const worker = waitingWorker
  const container = globalThis.navigator?.serviceWorker
  if (worker && container) {
    container.addEventListener("controllerchange", () => location.reload(), { once: true })
    worker.postMessage({ type: "SKIP_WAITING" })
    // A worker that never takes over must not leave the button dead.
    globalThis.setTimeout(() => location.reload(), 3000)
    return
  }
  location.reload()
}

/** For tests: forget what was reported. */
export function resetUpdate(): void {
  newerBuild = null
  waitingWorker = null
  emit()
}
