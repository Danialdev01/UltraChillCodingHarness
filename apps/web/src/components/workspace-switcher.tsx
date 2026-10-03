"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronsUpDownIcon, GalleryVerticalEndIcon, PlusIcon } from "lucide-react";

import { NewWorkspaceDialog, selectWorkspace } from "@/components/new-workspace-dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
 * A searchable list rather than a plain menu: most people have more than ten
 * workspaces, and scrolling a menu for the right one is slower than typing
 * the first few letters of its name.
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
  const [open, setOpen] = useState(false);
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
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  role="combobox"
                  aria-expanded={open}
                  aria-label="Workspace"
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
            </PopoverTrigger>

            {/* Overshot left so it clamps flush to the sidebar's edge rather
                than sitting inset by the header's padding, and widened to the
                whole sidebar to match. Unlike the dropdown menu, a popover
                answers alignment overflow by flipping start to end, which
                would put the overshoot on the right instead -- so it is told
                to shift, which is what clamps it. The panel is portalled to
                <body>, so the sidebar's overflow-hidden does not clip it --
                and for the same reason its width comes from the :root token
                rather than the provider's inline --sidebar-width, which does
                not inherit across a portal. */}
            <PopoverContent
              side="bottom"
              align="start"
              alignOffset={-RAIL_OVERLAP_PX}
              collisionAvoidance={{ align: "shift" }}
              collisionPadding={0}
              sideOffset={4}
              className="w-(--ucch-sidebar-width) min-w-56 p-0"
            >
              <Command>
                <CommandInput placeholder="Search workspaces…" />
                <CommandList>
                  <CommandEmpty>No workspace matches that.</CommandEmpty>
                  <CommandGroup>
                    {workspaces.map((workspace) => (
                      <CommandItem
                        key={workspace.id}
                        // The name is what gets matched on; the id is appended
                        // so two same-named workspaces stay distinct rows.
                        value={`${workspace.name} ${workspace.id}`}
                        keywords={[workspace.slug]}
                        // The row's own tick, which `CommandItem` renders and
                        // this is the switch for.
                        data-checked={workspace.id === active?.id}
                        onSelect={() => {
                          setOpen(false);
                          select(workspace.id);
                        }}
                      >
                        <div className="grid min-w-0 flex-1 leading-tight">
                          <span className="truncate">{workspace.name}</span>
                          <span className="text-muted-foreground truncate text-xs">
                            {workspace.projectCount}{" "}
                            {workspace.projectCount === 1 ? "project" : "projects"}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>

                  <CommandSeparator />

                  <CommandGroup>
                    <CommandItem
                      value="__add-workspace"
                      // Always shown, whatever was typed: creating one is the
                      // answer when the search finds nothing.
                      forceMount
                      onSelect={() => {
                        setOpen(false);
                        setCreating(true);
                      }}
                    >
                      <PlusIcon />
                      Add workspace
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </SidebarMenuItem>
      </SidebarMenu>

      <NewWorkspaceDialog open={creating} onOpenChange={setCreating} onCreated={select} />
    </>
  );
}
