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

/**
 * What the app shell fetches in the background once the first page is idle
 * (see `components/route-warmup.tsx`): every page a click on the rail, the
 * Settings list or the open project's pages can lead to.
 */

/**
 * Pages whose server render is expensive enough that a speculative full
 * render is not worth it: only their skeleton is prefetched. Usage walks
 * every project directory on disk.
 */
export const SKELETON_ONLY: ReadonlySet<string> = new Set([settingsPageHref("usage")])

/**
 * Every address worth having ready, the page in view excluded. `workspace`
 * is the one the shell has open; without one only the global pages are
 * warmed.
 */
export function warmupHrefs(
  pathname: string,
  workspace: { hash: string; kind: ProjectKind } | null,
  projectHashes: readonly string[],
): string[] {
  const hrefs: string[] = [HOME.href, SETTINGS.entry, ...SETTINGS_PAGES.map((p) => settingsPageHref(p.id))]
  if (workspace) {
    const ws = workspace.hash
    hrefs.push(
      ...SECTIONS.map((s) => sectionHref(s, ws)),
      sectionEntry(WORKSPACE_SETTINGS, ws),
      ...WORKSPACE_SETTINGS_PAGES.map((p) => workspaceSettingsPageHref(ws, p.id)),
    )
    // The project in view, or else the first in the list -- the one Code and
    // the dashboard put at the top, so the likeliest to be opened next. A
    // project's bare address only redirects to a session, so its pages are
    // what is warmed; a session workspace's session is a page of its own.
    // Off a project, the three at the top of the list -- the recently active
    // ones, so the likeliest next clicks.
    const inView = projectHashFromPath(pathname)
    const hashes = inView ? [inView] : projectHashes.slice(0, 3)
    for (const hash of hashes) {
      if (workspace.kind === "session") hrefs.push(projectHref(ws, "session", hash))
      if (workspace.kind === "project") hrefs.push(...PROJECT_PAGES.map((p) => projectPageHref(ws, hash, p.id)))
    }
  }
  return [...new Set(hrefs)].filter((href) => href !== pathname)
}
