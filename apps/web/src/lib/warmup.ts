import { projectQueries, type ProjectQuery } from "./queries/project-data"
import type { ProjectSession } from "./session"
import {
  HOME,
  PROJECT_PAGES,
  SECTIONS,
  SETTINGS,
  SETTINGS_PAGES,
  WORKSPACE_SETTINGS,
  WORKSPACE_SETTINGS_PAGES,
  projectHashFromPath,
  projectHref,
  projectPageHref,
  sectionEntry,
  sectionHref,
  settingsPageHref,
  workspaceSettingsPageHref,
  type ProjectKind,
} from "./sections"
import { isTaskThreadTitle } from "./tasks-api"

/**
 * What the app loads ahead of time (see `lib/preload.ts`): every page a click
 * on the rail, the Settings list or a project in the sidebar can lead to, and
 * the lists those pages open on.
 */

/**
 * Pages whose server render is expensive enough that a speculative full
 * render is not worth it: only their skeleton is prefetched. Usage walks
 * every project directory on disk.
 */
export const SKELETON_ONLY: ReadonlySet<string> = new Set([settingsPageHref("usage")])

/**
 * How much is loaded ahead, so that a large workspace costs a bounded amount
 * of memory and of server time.
 *
 * Each project in the plan is about seven page renders (a few tens of KB of
 * RSC payload each) and five short lists. Past `projects`, a project gets
 * only its sessions list -- a few hundred bytes, and what lets its sidebar
 * link go straight to the conversation rather than through a redirect.
 * File trees can run to thousands of rows, so only the first few are loaded.
 * Never loaded ahead: file contents, note bodies, git state, database rows,
 * or anything of another workspace.
 */
export interface WarmupBudget {
  /** Projects whose every page and list is loaded. */
  projects: number
  /** Projects whose sessions list is loaded. */
  sessionLists: number
  /** Projects whose open session's file tree is loaded. */
  fileTrees: number
  /** Projects kept warm while the tab is in use, past the router's expiry. */
  hot: number
}

export const BUDGET: WarmupBudget = { projects: 20, sessionLists: 60, fileTrees: 5, hot: 5 }

/** Half of everything on a device that reports 4 GB of memory or less. */
export function budgetFor(deviceMemory: number | undefined): WarmupBudget {
  if (deviceMemory === undefined || deviceMemory > 4) return BUDGET
  return {
    projects: Math.ceil(BUDGET.projects / 2),
    sessionLists: Math.ceil(BUDGET.sessionLists / 2),
    fileTrees: Math.ceil(BUDGET.fileTrees / 2),
    hot: Math.ceil(BUDGET.hot / 2),
  }
}

/** The session a click on a project opens: its newest that is not a Tasks-board thread. */
export function openSession(sessions: readonly ProjectSession[] | undefined): ProjectSession | undefined {
  return sessions?.find((s) => !isTaskThreadTitle(s.title))
}

export interface WarmupInput {
  /** The page in view, or the one about to be opened. */
  pathname: string
  /** Whether `pathname` itself is to be loaded: yes before it opens, no once it is on screen. */
  includeCurrent: boolean
  /** The workspace the shell has open; without one only the global pages are warmed. */
  workspace: { hash: string; kind: ProjectKind } | null
  /** The workspace's projects, most recently active first. */
  projectHashes: readonly string[]
  /** A project's sessions, when they are cached. */
  sessions?: (projectHash: string) => readonly ProjectSession[] | undefined
  budget?: WarmupBudget
}

/** The projects in the plan, the one in view first. */
function rankedProjects(pathname: string, projectHashes: readonly string[]): string[] {
  const inView = projectHashFromPath(pathname)
  return inView ? [inView, ...projectHashes.filter((h) => h !== inView)] : [...projectHashes]
}

/** Whose sessions lists are loaded before anything else: the plan's links depend on them. */
export function sessionListHashes(input: Pick<WarmupInput, "pathname" | "workspace" | "projectHashes" | "budget">): string[] {
  if (input.workspace?.kind !== "project") return []
  return rankedProjects(input.pathname, input.projectHashes).slice(0, (input.budget ?? BUDGET).sessionLists)
}

export interface WarmupPlan {
  /** Every page to prefetch, likeliest first. */
  routes: string[]
  /** The part of `routes` kept warm while the tab is in use. */
  hot: string[]
  /** The lists those pages open on. */
  data: ProjectQuery<unknown>[]
}

export function warmupPlan(input: WarmupInput): WarmupPlan {
  const budget = input.budget ?? BUDGET
  const { workspace, pathname } = input
  const first: string[] = input.includeCurrent ? [pathname] : []
  const sections: string[] = []
  const projectRoutes: string[] = []
  const hotProjects: string[] = []
  const data: ProjectQuery<unknown>[] = []

  if (workspace) {
    const ws = workspace.hash
    sections.push(
      ...SECTIONS.map((s) => sectionHref(s, ws)),
      sectionEntry(WORKSPACE_SETTINGS, ws),
      ...WORKSPACE_SETTINGS_PAGES.map((p) => workspaceSettingsPageHref(ws, p.id)),
    )
    rankedProjects(pathname, input.projectHashes)
      .slice(0, budget.projects)
      .forEach((hash, rank) => {
        if (workspace.kind === "session") {
          const href = projectHref(ws, "session", hash)
          projectRoutes.push(href)
          if (rank < budget.hot) hotProjects.push(href)
          return
        }
        // A project's bare address redirects to its newest session, so the
        // session itself is what is warmed once its list says which. Without
        // one, the bare address is the page: it starts the first session.
        const open = openSession(input.sessions?.(hash))
        const pages = [
          projectHref(ws, "project", hash, open?.hash),
          ...PROJECT_PAGES.map((p) => projectPageHref(ws, hash, p.id)),
        ]
        projectRoutes.push(...pages)
        if (rank < budget.hot) hotProjects.push(...pages.slice(0, 2))

        data.push(
          projectQueries.tasks(hash),
          projectQueries.taskSettings(hash),
          projectQueries.notesTree(hash),
          projectQueries.timeline(hash),
          projectQueries.keys(hash),
        )
        // The tree the session's file panel opens on: its worktree's when it
        // has a branch of its own, else the project's checkout.
        if (open && rank < budget.fileTrees) {
          data.push(projectQueries.filesTree(open.branch ? { hash, session: open.hash } : hash))
        }
      })
  }

  const global = [HOME.href, SETTINGS.entry, ...SETTINGS_PAGES.map((p) => settingsPageHref(p.id))]
  const keep = (hrefs: string[]) =>
    [...new Set(hrefs)].filter((href) => input.includeCurrent || href !== pathname)
  return {
    // The project in view comes first in `projectRoutes`, but after the
    // rail: a section is one click away from anywhere.
    routes: keep([...first, ...sections, ...projectRoutes, ...global]),
    hot: keep([...first, ...sections, ...hotProjects]),
    data,
  }
}
