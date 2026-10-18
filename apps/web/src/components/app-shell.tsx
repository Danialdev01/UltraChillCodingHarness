import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

import { AppHeader } from "@/components/app-header"
import { AppSidebar } from "@/components/app-sidebar"
import { FilesPanelProvider } from "@/components/files-panel"
import { RealtimeProvider } from "@/lib/realtime"
import { RightSidebar } from "@/components/right-sidebar"
import { RouteWarmup } from "@/components/route-warmup"
import { ViewerProvider } from "@/components/viewer"
import { MAIN_CONTENT_ID, SkipLink } from "@/components/skip-link"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import {
  getSession,
  listDatabaseConnections,
  listProjects,
  listWorkspaces,
  pickActiveWorkspace,
} from "@/lib/session"
import { ActiveWorkspaceProvider } from "@/lib/workspace-context"
import { WORKSPACE_COOKIE_NAME } from "@/lib/workspace-cookie"
import { WORKSPACE_HEADER } from "@/lib/workspace-header"

/**
 * The authenticated chrome every page inside the app renders into: the
 * two-column sidebar, the header, and the session/workspace resolution they
 * both depend on.
 *
 * Rendered by the `(app)` layout rather than by each page, and that is what
 * makes a page switch instant: a layout is kept across navigations, so
 * moving between sections neither refetches the session, the workspaces and
 * the projects nor re-renders the sidebar -- only the page inside changes,
 * and it shows its skeleton (`loading.tsx`) the moment the URL does. Anything
 * here that depends on *which* page is open reads the URL on the client
 * (`AppHeader`, `AppSidebar`) rather than being told by the page.
 *
 * Gated here so an unauthenticated visitor never receives the shell at all,
 * rather than receiving it and having it blank itself out on the client.
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const jar = await cookies()
  const requested = jar.get(WORKSPACE_COOKIE_NAME)?.value
  // The workspace in the URL, `/{ws}/…`, as the middleware passes it on.
  // Pages outside any workspace (`/`, `/setting`) fall back to the cookie,
  // which remembers the last one open.
  const addressed = (await headers()).get(WORKSPACE_HEADER)

  // All at once, rather than session, then workspaces, then their contents:
  // the API checks the session on each of these itself, so nothing is
  // learned by waiting, and the shell was three round trips deep. The
  // workspace's projects are fetched on the cookie's say-so and refetched
  // below only in the rare case the cookie turns out to be stale.
  const [session, workspaces, guessed] = await Promise.all([
    getSession(),
    listWorkspaces(),
    requested
      ? Promise.all([listProjects(requested), listDatabaseConnections(requested)])
      : null,
  ])
  if (!session) redirect("/login")

  // The cookie may name a workspace that was deleted, or one belonging to a
  // different account after re-login, so it is a hint rather than a fact.
  // An address naming no workspace of the caller's is an old project
  // bookmark; its page redirects, and the shell shows the cookie's meanwhile.
  const active = pickActiveWorkspace(workspaces, requested, addressed)
  const [projects, connections] =
    guessed && active?.id === requested
      ? guessed
      : await Promise.all([
          listProjects(active?.id ?? ""),
          listDatabaseConnections(active?.id ?? ""),
        ])

  // SidebarProvider writes `sidebar_state` on toggle but does not read it
  // back, so without this a collapsed sidebar silently re-expands on reload.
  // Absent cookie means expanded, which is the intended default.
  const defaultOpen = jar.get("sidebar_state")?.value !== "false"

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      // The app is exactly one screen tall and never scrolls as a document.
      // Without this the shell is `min-h-svh` and grows with its content, so
      // a long conversation pushed the composer off the bottom of the window
      // and took the file tree's height with it -- both of them scrolled away
      // together, and there was nothing to scroll *inside*.
      className="h-svh overflow-hidden"
      // Sourced from the :root token so the portalled workspace-switcher
      // dropdown can size itself to the same width. See globals.css.
      style={{ "--sidebar-width": "var(--ucch-sidebar-width)" } as React.CSSProperties}
    >
      <SkipLink />
      {/* Once the first page is idle, fetches the rest of the app so later clicks find it loaded. */}
      <RouteWarmup
        workspace={active ? { hash: active.hash, kind: active.kind } : null}
        projectHashes={projects.map((p) => p.hash)}
      />
      <ActiveWorkspaceProvider workspace={active} workspaces={workspaces}>
        <RealtimeProvider>
          <ViewerProvider name={session.name ?? session.login ?? "User"}>
            <FilesPanelProvider>
              <AppSidebar
                user={{
                  name: session.name ?? session.login ?? "User",
                  email: session.email ?? "",
                  // `undefined`, never "": an empty `src` is a request for the
                  // page itself, which the browser then reports as a broken image.
                  avatar: session.avatarUrl ?? undefined,
                }}
                workspaces={workspaces}
                activeWorkspaceId={active?.id ?? ""}
                projects={projects}
                connections={connections}
              />
              <SidebarInset className="min-h-0 overflow-hidden">
                <AppHeader
                  projects={projects}
                  connections={connections}
                  sessionWorkspace={active?.kind === "session"}
                />
                {/* The right-hand column -- the file tree or the search results -- is
                    a flex sibling of the page rather than an overlay, so opening it
                    narrows the content instead of covering it; and it lives inside
                    the inset, below the header, so the header stays one unbroken bar
                    across the app. */}
                <div className="flex min-h-0 flex-1">
                  {/* The page scrolls here rather than the window: a chat keeps its
                      composer pinned by bounding its own message list, and a page
                      that is simply long -- the dashboard, a section -- scrolls
                      within the same box. */}
                  {/* The one element the view transition animates: the sidebar and
                      header have no transition name, so a page change crossfades
                      this box and leaves the chrome around it still. */}
                  <div
                    id={MAIN_CONTENT_ID}
                    tabIndex={-1}
                    className="ucch-page flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [view-transition-name:page] focus-visible:outline-none"
                  >
                    {children}
                  </div>
                  <RightSidebar />
                </div>
              </SidebarInset>
            </FilesPanelProvider>
          </ViewerProvider>
        </RealtimeProvider>
      </ActiveWorkspaceProvider>
    </SidebarProvider>
  )
}
