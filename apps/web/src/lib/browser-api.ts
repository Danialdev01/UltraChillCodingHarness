/**
 * The Browser view's side of the agents' shared browser. The shapes are
 * `@ucch/browser`'s (`BrowserSessionInfo`), kept here rather than imported:
 * that package brings a browser driver the web build has no use for.
 */

export interface BrowserTabInfo {
  id: string
  /** What the person who opened it called it, if they did. */
  name: string | null
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
  /** The most tabs one chat session may have open. */
  maxTabs: number
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

/** One element of a captured page. */
export interface AnnotatedElement {
  selector: string
  tag: string
  role: string | null
  label: string | null
  text: string
  rect: { x: number; y: number; w: number; h: number }
  styles: Record<string, string>
}

/** A tab frozen for marking up. */
export interface BrowserCapture {
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number }
  elements: AnnotatedElement[]
  /** Base64 PNG of the viewport. */
  image: string
}

/** The browser session a chat session's agent has to itself, as the server names it. */
export function privateSessionName(threadId: string): string {
  return `private-${threadId.slice(0, 8)}`
}

/**
 * The tabs that count against a chat session's limit: all of its private
 * session's, and those its agent opened in shared ones. Without a chat
 * session, the ones people opened in `shared`.
 */
export function tabsOfSession(sessions: readonly BrowserSessionInfo[], threadId: string | null): number {
  let count = 0
  for (const s of sessions) {
    if (threadId && s.owner === threadId) count += s.tabs.length
    else if (threadId) count += s.tabs.filter((t) => t.openedBy === threadId).length
    else if (s.name === "shared") count += s.tabs.filter((t) => t.openedBy === "human").length
  }
  return count
}

/** Freezes a tab for marking up: its picture and where every element is. */
export async function captureBrowserTab(projectHash: string, session: string, tab: string): Promise<BrowserCapture> {
  const response = await fetch(
    `/api/projects/${projectHash}/browser/tabs/${encodeURIComponent(session)}/${encodeURIComponent(tab)}/capture`,
    { method: "POST", credentials: "include" },
  )
  if (!response.ok) throw await failure(response, "Could not capture the page.")
  return (await response.json()) as BrowserCapture
}

/** A person opens a tab for a chat session's agent, or with none in the `shared` session. */
export async function openBrowserTab(
  projectHash: string,
  thread: string | null,
  url: string,
  name: string | null,
): Promise<{ session: string; tab: string }> {
  const response = await fetch(`/api/projects/${projectHash}/browser/tabs`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread, url, name }),
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
