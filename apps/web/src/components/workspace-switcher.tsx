"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, GalleryVerticalEndIcon, PlusIcon } from "lucide-react";

import { NewWorkspaceDialog, selectWorkspace } from "@/components/new-workspace-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { RAIL_OVERLAP_PX } from "@/lib/sidebar-metrics";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  projectCount: number;
}

/**
 * Switches between workspaces and creates new ones.
 *
 * The active workspace is kept in a cookie rather than component state so the
 * server component rendering the dashboard can read it too -- otherwise the
 * server would render one workspace's projects while the switcher displayed
 * another's.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  function select(workspaceId: string) {
    selectWorkspace(workspaceId);
    router.refresh();
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                />
              }
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <GalleryVerticalEndIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active?.name ?? "No workspace"}</span>
                <span className="truncate text-xs">
                  {active
                    ? `${active.projectCount} ${active.projectCount === 1 ? "project" : "projects"}`
                    : "Create one to start"}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </DropdownMenuTrigger>

            {/* Pulled left past the icon rail so the panel covers it
                rail rather than sitting inside the second column, and
                widened to the whole sidebar to match. The menu is portalled
                to <body>, so the sidebar's overflow-hidden does not clip it
                -- and for the same reason its width comes from the :root
                token rather than the provider's inline --sidebar-width,
                which does not inherit across a portal. */}
            <DropdownMenuContent
              side="bottom"
              align="start"
              alignOffset={-RAIL_OVERLAP_PX}
              collisionPadding={0}
              sideOffset={4}
              className="w-(--ucch-sidebar-width) min-w-56"
            >
              {workspaces.map((workspace) => (
                <DropdownMenuItem key={workspace.id} onSelect={() => select(workspace.id)}>
                  <div className="grid flex-1 leading-tight">
                    <span className="truncate">{workspace.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {workspace.projectCount}{" "}
                      {workspace.projectCount === 1 ? "project" : "projects"}
                    </span>
                  </div>
                  {workspace.id === active?.id && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <PlusIcon />
                Add workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <NewWorkspaceDialog open={creating} onOpenChange={setCreating} onCreated={select} />
    </>
  );
}
