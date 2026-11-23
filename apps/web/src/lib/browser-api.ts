/**
 * The Browser view's side of the agents' shared browser. The shapes are
 * `@ucch/browser`'s (`BrowserSessionInfo`), kept here rather than imported:
 * that package brings a browser driver the web build has no use for.
 */

export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  /** The agent session (thread id) that opened it, or "human". */
  openedBy: string
  /** Who is acting on it right now: an agent's thread id, a person's user id, or null. */
  busy: string | null
  /** The person controlling it, if any: agents may read it but not act on it. */
  controlledBy: string | null
  viewport: { width: number; height: number }
}

export interface BrowserSessionInfo {
  name: string
  shared: boolean
  owner: string | null
  tabs: BrowserTabInfo[]
  lastUsedAt: string
}

/** The project's shared browser, as `GET /api/projects/:hash/browser` lists it. */
export interface ProjectBrowser {
  /** False when the server has no Chromium or has the browser turned off. */
  available: boolean
  reason: string | null
  sessions: BrowserSessionInfo[]
}

async function failure(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  return new Error(body.error ?? fallback)
}

export async function fetchProjectBrowser(projectHash: string): Promise<ProjectBrowser> {
  const response = await fetch(`/api/projects/${projectHash}/browser`, { credentials: "include" })
  if (!response.ok) throw await failure(response, "Could not list the browser's sessions.")
  return (await response.json()) as ProjectBrowser
}

/** A person opens a tab, in control of it, in a shared session (created when new). */
export async function openBrowserTab(projectHash: string, session: string, url: string | null): Promise<{ session: string; tab: string }> {
  const response = await fetch(`/api/projects/${projectHash}/browser/tabs`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, url }),
  })
  if (!response.ok) throw await failure(response, "Could not open a tab.")
  return (await response.json()) as { session: string; tab: string }
}

export async function closeBrowserTab(projectHash: string, session: string, tab: string): Promise<void> {
  const response = await fetch(`/api/projects/${projectHash}/browser/tabs/${encodeURIComponent(session)}/${encodeURIComponent(tab)}`, {
    method: "DELETE",
    credentials: "include",
  })
  if (!response.ok) throw await failure(response, "Could not close the tab.")
}
