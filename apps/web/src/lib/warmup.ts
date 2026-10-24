import { projectQueries, type ProjectQuery } from "./queries/project-data"
import type { ProjectSession } from "./session"
import { projectHashFromPath, type ProjectKind } from "./sections"
import { isTaskThreadTitle } from "./tasks-api"

/**
 * What the app loads ahead of time (see `lib/preload.ts`): data, not pages.
 *
 * A click paints the next page's skeleton in the same frame without any of
 * this -- `TransitionLink` leaves Next's viewport prefetch on, which loads
 * each visible link down to its `loading.tsx` -- and the content is instant
 * wherever the client cache already holds the lists the page opens on. That
 * cache is persisted, so what is loaded here outlives a reload without
 * asking the server again. No page is rendered ahead: a speculative render
 * costs the server far more than the lists it would show.
 */

/**
 * How much is loaded ahead, so that a large workspace costs a bounded amount
 * of memory and of server time.
 *
 * Each project in `projects` is five short lists. Past them, a project gets
 * only its sessions list -- a few hundred bytes, and what lets its sidebar
 * link go straight to the conversation rather than through a redirect.
 * File trees can run to thousands of rows, so only the first is loaded.
 * Never loaded ahead: file contents, note bodies, git state, database rows,
 * or anything of another workspace.
 */
export interface WarmupBudget {
  /** Projects whose every list is loaded. */
  projects: number
  /** Projects whose sessions list is loaded. */
  sessionLists: number
  /** Projects whose open session's file tree is loaded. */
  fileTrees: number
}

export const BUDGET: WarmupBudget = { projects: 3, sessionLists: 20, fileTrees: 1 }

/** Half of everything on a device that reports 4 GB of memory or less. */
export function budgetFor(deviceMemory: number | undefined): WarmupBudget {
  if (deviceMemory === undefined || deviceMemory > 4) return BUDGET
  return {
    projects: Math.ceil(BUDGET.projects / 2),
    sessionLists: Math.ceil(BUDGET.sessionLists / 2),
    fileTrees: Math.ceil(BUDGET.fileTrees / 2),
  }
}

/** The session a click on a project opens: its newest that is not a Tasks-board thread. */
export function openSession(sessions: readonly ProjectSession[] | undefined): ProjectSession | undefined {
  return sessions?.find((s) => !isTaskThreadTitle(s.title))
}

/** The lists a project's pages open on, as its row in the sidebar leads to them. */
export function projectLists(hash: string): ProjectQuery<unknown>[] {
  return [
    projectQueries.tasks(hash),
    projectQueries.taskSettings(hash),
    projectQueries.notesTree(hash),
    projectQueries.timeline(hash),
    projectQueries.keys(hash),
  ]
}

export interface WarmupInput {
  /** The page in view. */
  pathname: string
  /** The workspace the shell has open; without one there are no lists to load. */
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

/** Whose sessions lists are loaded before anything else: the plan's file trees depend on them. */
export function sessionListHashes(input: Pick<WarmupInput, "pathname" | "workspace" | "projectHashes" | "budget">): string[] {
  if (input.workspace?.kind !== "project") return []
  return rankedProjects(input.pathname, input.projectHashes).slice(0, (input.budget ?? BUDGET).sessionLists)
}

export interface WarmupPlan {
  /** The lists the likeliest pages open on. */
  data: ProjectQuery<unknown>[]
}

export function warmupPlan(input: WarmupInput): WarmupPlan {
  const budget = input.budget ?? BUDGET
  const { workspace, pathname } = input
  const data: ProjectQuery<unknown>[] = []

  // A session workspace's projects are conversations: nothing to list ahead.
  if (workspace?.kind === "project") {
    rankedProjects(pathname, input.projectHashes)
      .slice(0, budget.projects)
      .forEach((hash, rank) => {
        data.push(...projectLists(hash))
        // The tree the session's file panel opens on: its worktree's when it
        // has a branch of its own, else the project's checkout.
        const open = openSession(input.sessions?.(hash))
        if (open && rank < budget.fileTrees) {
          data.push(projectQueries.filesTree(open.branch ? { hash, session: open.hash } : hash))
        }
      })
  }

  return { data }
}
