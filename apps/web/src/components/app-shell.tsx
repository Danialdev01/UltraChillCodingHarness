import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getSession, listProjects, listWorkspaces } from "@/lib/session"

/**
 * The authenticated chrome every page inside the app renders into: the
 * two-column sidebar, the header, and the session/workspace resolution they
 * both depend on.
 *
 * Gated here so an unauthenticated visitor never receives the shell at all,
 * rather than receiving it and having it blank itself out on the client.
 */
export async function AppShell({
  breadcrumb,
  activeProjectHash,
  children,
}: {
  breadcrumb: string[]
  activeProjectHash?: string
  children: React.ReactNode
}) {
  const session = await getSession()
  if (!session) redirect("/login")

  const workspaces = await listWorkspaces()
  const jar = await cookies()
  const requested = jar.get("ucch_workspace")?.value
  // The cookie may name a workspace that was deleted, or one belonging to a
  // different account after re-login, so it is a hint rather than a fact.
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0]
  const projects = await listProjects(active?.id ?? "")

  // SidebarProvider writes `sidebar_state` on toggle but does not read it
  // back, so without this a collapsed sidebar silently re-expands on reload.
  // Absent cookie means expanded, which is the intended default.
  const defaultOpen = jar.get("sidebar_state")?.value !== "false"

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      // Sourced from the :root token so the portalled workspace-switcher
      // dropdown can size itself to the same width. See globals.css.
      style={{ "--sidebar-width": "var(--ucch-sidebar-width)" } as React.CSSProperties}
    >
      <AppSidebar
        user={{
          name: session.name ?? session.login ?? "User",
          email: session.email ?? "",
          avatar: session.avatarUrl ?? "",
        }}
        workspaces={workspaces}
        activeWorkspaceId={active?.id ?? ""}
        projects={projects}
        activeProjectHash={activeProjectHash}
      />
      <SidebarInset>
        <header className="bg-background sticky top-0 flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumb.map((crumb, i) => (
                <BreadcrumbItem key={crumb}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbPage>{crumb}</BreadcrumbPage>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
