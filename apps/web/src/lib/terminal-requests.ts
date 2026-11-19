/**
 * Requests from the sidebar to the Terminal page: "open this server in a
 * new tab". The page may not be mounted yet when the row is clicked -- the
 * click also navigates there -- so a request is held until the page takes
 * it, and delivered at once when it is already listening.
 */

type Listener = (hostId: string) => void

let pending: string | null = null
const listeners = new Set<Listener>()

export function requestOpenHost(hostId: string): void {
  if (listeners.size === 0) {
    pending = hostId
    return
  }
  pending = null
  for (const listener of listeners) listener(hostId)
}

/** Listens for open requests, taking one that arrived before it did. Returns the unsubscribe. */
export function onOpenHostRequest(listener: Listener): () => void {
  listeners.add(listener)
  if (pending) {
    const hostId = pending
    pending = null
    listener(hostId)
  }
  return () => listeners.delete(listener)
}
