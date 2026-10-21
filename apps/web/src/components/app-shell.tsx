import { cookies } from "next/headers"
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
import { LastLocation } from "@/lib/last-location"
import { BootstrapSeed } from "@/lib/queries/bootstrap"
import { QueryProvider } from "@/lib/query-client"
import { getBootstrap } from "@/lib/session"
import { ActiveWorkspaceProvider } from "@/lib/workspace-context"

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
export async function AppShell({ booted, children }: { booted: boolean; children: React.ReactNode }) {
  const jar = await cookies()

  // One request for everything below: the session, the workspaces, which is
  // open (the address's, else the cookie's last) and its projects and
  // connections. The page inside shares it -- `getBootstrap` is cached for
  // the request -- so a page that asks for its workspace costs nothing more.
  const boot = await getBootstrap()
  if (!boot) redirect("/login")
  const { me: session, workspaces, projects, connections } = boot
  const active = workspaces.find((w) => w.id === boot.activeWorkspaceId)

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
      <QueryProvider userId={session.userId} buildId={boot.buildId}>
      <BootstrapSeed data={boot} />
      {/* Loads the rest of the app -- behind the boot screen on a session's first page -- so later clicks find it loaded. */}
      <RouteWarmup
        workspace={active ? { hash: active.hash, kind: active.kind } : null}
        projectHashes={projects.map((p) => p.hash)}
        gate={!booted}
      />
      <LastLocation />
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
      </QueryProvider>
    </SidebarProvider>
  )
}
