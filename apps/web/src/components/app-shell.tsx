import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { AppHeader } from "@/components/app-header"
import { AppSidebar } from "@/components/app-sidebar"
import { FilesPanelProvider } from "@/components/files-panel"
import { RealtimeProvider } from "@/lib/realtime"
import { RightSidebar } from "@/components/right-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { getSession, listDatabaseConnections,
  listProjects, listWorkspaces } from "@/lib/session"

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
  const session = await getSession()
  if (!session) redirect("/login")

  const workspaces = await listWorkspaces()
  const jar = await cookies()
  const requested = jar.get("ucch_workspace")?.value
  // The cookie may name a workspace that was deleted, or one belonging to a
  // different account after re-login, so it is a hint rather than a fact.
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0]
  const [projects, connections] = await Promise.all([
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
      <RealtimeProvider>
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
              <div className="ucch-page flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [view-transition-name:page]">
                {children}
              </div>
              <RightSidebar />
            </div>
          </SidebarInset>
        </FilesPanelProvider>
      </RealtimeProvider>
    </SidebarProvider>
  )
}
