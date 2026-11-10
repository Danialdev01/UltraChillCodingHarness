/**
 * The session sidebar's logic, apart from React: what a session's status
 * is, how the list is ordered and grouped, what a search matches and what
 * the filters keep. `components/session-sidebar/` draws what this decides.
 */

import { harnessIdOf, sessionModelLabel, type HarnessId } from "./harnesses"

/** One session as `GET /api/workspaces/:id/sessions` lists it. */
export interface SidebarSession {
  id: string
  hash: string | null
  title: string
  /** The thread's own: idle, queued, running, cancelling, error. */
  status: string
  provider: string | null
  model: string | null
  lastTurn: "done" | "failed" | "stopped" | null
  branch: string | null
  baseBranch: string | null
  worktreeState: string | null
  /**
   * The last settle's outcome: `settled` (merged into `settleBaseBranch` at
   * `mergeCommitSha`, worktree removed) or `failed` (the merge conflicted
   * in `settleConflicts` and was aborted). Null until settled.
   */
  settleState?: "settled" | "failed" | null
  settleError?: string | null
  settleConflicts?: string[] | null
  settleBaseBranch?: string | null
  mergeCommitSha?: string | null
  settledAt?: string | null
  pinned: boolean
  archivedAt: string | null
  lastActivityAt: string
  createdAt: string
  createdByUserId: string | null
  project: SidebarProject
}

export interface SidebarProject {
  id: string
  hash: string
  name: string
  stack: string | null
  lastActiveAt?: string | null
  /** The project's base branch: what its sessions fork from and settle into. */
  baseBranch?: string | null
  /** Where its repository lives, `host/owner/name`; null for a local-only one. */
  repo?: string | null
}

export interface WorkspaceSessions {
  workspaceName: string | null
  sessions: SidebarSession[]
  projects: SidebarProject[]
}

export type SidebarMode = "sessions" | "projects"

export type SessionStatus = "idle" | "running" | "waiting_input" | "settled" | "error" | "archived"

/** What this tab has heard about a session's turn since the list was read. */
export type LiveTurnState = "queued" | "running" | "waiting" | "done" | "failed" | "idle"

/**
 * The status to draw. What the socket said wins over the row, which is only
 * as fresh as the last fetch; the row decides until there is something live.
 */
export function statusOf(session: SidebarSession, live?: LiveTurnState): SessionStatus {
  if (session.archivedAt) return "archived"
  switch (live) {
    case "queued":
    case "running":
      return "running"
    case "waiting":
      return "waiting_input"
    case "failed":
      return "error"
    case "done":
      return "settled"
    case "idle":
      return "idle"
  }
  if (session.status === "running" || session.status === "queued" || session.status === "cancelling") return "running"
  if (session.status === "error" || session.lastTurn === "failed") return "error"
  if (session.lastTurn === "done") return "settled"
  return "idle"
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(t) ? 0 : t
}

const isMerged = (s: SidebarSession) => s.settleState === "settled" && !s.pinned

/**
 * Pinned first, settled (merged) last, otherwise the most recent activity;
 * ties by title so the order is stable.
 */
export function compareSessions(a: SidebarSession, b: SidebarSession): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (isMerged(a) !== isMerged(b)) return isMerged(a) ? 1 : -1
  const by = time(b.lastActivityAt) - time(a.lastActivityAt)
  return by !== 0 ? by : a.title.localeCompare(b.title)
}

export function sortSessions(sessions: readonly SidebarSession[]): SidebarSession[] {
  return [...sessions].sort(compareSessions)
}

export type DateBucket = "Pinned" | "Today" | "Yesterday" | "This week" | "Older" | "Settled"

/**
 * Which divider a session falls under: by its last activity in local time,
 * or "Settled" once its work is merged -- at the bottom, out of the way.
 */
export function dateBucket(session: SidebarSession, now: Date): DateBucket {
  if (session.pinned) return "Pinned"
  if (isMerged(session)) return "Settled"
  const at = new Date(time(session.lastActivityAt))
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (at.getTime() >= startOfDay) return "Today"
  if (at.getTime() >= startOfDay - day) return "Yesterday"
  if (at.getTime() >= startOfDay - 6 * day) return "This week"
  return "Older"
}

export interface ProjectGroup {
  project: SidebarProject
  sessions: SidebarSession[]
}

/**
 * Sessions under their projects. Every project is a group, the empty ones
 * too (they say "No sessions yet"), ordered by their latest session's
 * activity -- a project with none by its own -- then by name.
 */
export function groupByProject(
  sessions: readonly SidebarSession[],
  projects: readonly SidebarProject[],
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const project of projects) groups.set(project.id, { project, sessions: [] })
  for (const session of sessions) {
    let group = groups.get(session.project.id)
    if (!group) {
      group = { project: session.project, sessions: [] }
      groups.set(session.project.id, group)
    }
    group.sessions.push(session)
  }
  const latest = (g: ProjectGroup) =>
    g.sessions.reduce((max, s) => Math.max(max, time(s.lastActivityAt)), time(g.project.lastActiveAt))
  return [...groups.values()]
    .map((g) => ({ ...g, sessions: sortSessions(g.sessions) }))
    .sort((a, b) => latest(b) - latest(a) || a.project.name.localeCompare(b.project.name))
}

// -- Search -------------------------------------------------------------------

/** The text a search looks through, field by field. */
export function searchFields(session: SidebarSession, names?: ReadonlyMap<string, string>) {
  return {
    title: session.title,
    project: session.project.name,
    branch: [session.branch, session.settleBaseBranch ?? session.baseBranch ?? session.project.baseBranch]
      .filter(Boolean)
      .join(" "),
    model: sessionModelLabel(session.provider, session.model, names),
  }
}

/** Whether every word of the query is somewhere in the session's title, project, branch or model. */
export function matchSession(session: SidebarSession, query: string, names?: ReadonlyMap<string, string>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = Object.values(searchFields(session, names)).join("\n").toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** The [start, end) spans of `text` that the query's words match, merged, for highlighting. */
export function highlightRanges(text: string, query: string): [number, number][] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lower = text.toLowerCase()
  const spans: [number, number][] = []
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      spans.push([at, at + word.length])
    }
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }
  return merged
}

// -- Filters ------------------------------------------------------------------

export type FilterHarness = HarnessId | "unknown"
export type FilterStatus = Exclude<SessionStatus, "archived">

export interface SidebarFilters {
  harnesses: FilterHarness[]
  statuses: FilterStatus[]
  projects: string[]
  createdBy: "anyone" | "me"
  showArchived: boolean
}

export const NO_FILTERS: SidebarFilters = {
  harnesses: [],
  statuses: [],
  projects: [],
  createdBy: "anyone",
  showArchived: false,
}

export type FilterAction =
  | { type: "toggleHarness"; harness: FilterHarness }
  | { type: "toggleStatus"; status: FilterStatus }
  | { type: "toggleProject"; projectId: string }
  | { type: "createdBy"; value: SidebarFilters["createdBy"] }
  | { type: "showArchived"; value: boolean }
  | { type: "clear" }

const toggle = <T,>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item]

export function filterReducer(state: SidebarFilters, action: FilterAction): SidebarFilters {
  switch (action.type) {
    case "toggleHarness":
      return { ...state, harnesses: toggle(state.harnesses, action.harness) }
    case "toggleStatus":
      return { ...state, statuses: toggle(state.statuses, action.status) }
    case "toggleProject":
      return { ...state, projects: toggle(state.projects, action.projectId) }
    case "createdBy":
      return state.createdBy === action.value ? state : { ...state, createdBy: action.value }
    case "showArchived":
      return state.showArchived === action.value ? state : { ...state, showArchived: action.value }
    case "clear":
      return NO_FILTERS
  }
}

/** Whether anything narrows the list, for the dot on the filter button. */
export function filtersActive(filters: SidebarFilters): boolean {
  return (
    filters.harnesses.length > 0 ||
    filters.statuses.length > 0 ||
    filters.projects.length > 0 ||
    filters.createdBy !== "anyone" ||
    filters.showArchived
  )
}

/**
 * Whether a session passes the filters. Archived ones only while asked for;
 * within each list, any one entry is enough (an empty list keeps all).
 */
export function passesFilters(
  session: SidebarSession,
  filters: SidebarFilters,
  context: { userId: string | null; status: SessionStatus },
): boolean {
  if (context.status === "archived") {
    if (!filters.showArchived) return false
  } else if (filters.statuses.length > 0 && !filters.statuses.includes(context.status)) {
    return false
  }
  if (filters.harnesses.length > 0) {
    const harness: FilterHarness = harnessIdOf(session.provider) ?? "unknown"
    if (!filters.harnesses.includes(harness)) return false
  }
  if (filters.projects.length > 0 && !filters.projects.includes(session.project.id)) return false
  if (filters.createdBy === "me" && (!context.userId || session.createdByUserId !== context.userId)) return false
  return true
}

// -- Time ---------------------------------------------------------------------

/** "now", "5m", "6h", "3d", "2w": how long since the session last did anything. */
export function relativeTime(iso: string | null | undefined, now: number | null): string {
  if (now === null) return ""
  const then = time(iso)
  if (!then) return ""
  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 52) return `${weeks}w`
  return `${Math.floor(days / 365)}y`
}

/**
 * The branch line for a session: where its work is and where it goes.
 * `ucch/x → main` while it works; `merged into main @ abc1234` once
 * settled; just the project's base for a session in the main checkout.
 */
export function branchLine(session: SidebarSession): {
  text: string
  tone: "normal" | "merged" | "failed"
} {
  const base = session.settleBaseBranch ?? session.project.baseBranch ?? session.baseBranch ?? null
  if (session.settleState === "settled") {
    const sha = session.mergeCommitSha ? ` @ ${session.mergeCommitSha.slice(0, 7)}` : ""
    return { text: `merged into ${base ?? "base"}${sha}`, tone: "merged" }
  }
  const target = (branch: string) => (base && base !== branch ? `${branch} → ${base}` : branch)
  if (session.settleState === "failed") {
    return { text: `${target(session.branch ?? "?")} · settle failed`, tone: "failed" }
  }
  if (session.branch) return { text: target(session.branch), tone: "normal" }
  return { text: base ?? "", tone: "normal" }
}
