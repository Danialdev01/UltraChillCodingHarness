"use client";

import { useState } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronsUpDownIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ManageWorkspaceDialog, NewWorkspaceDialog, WorkspaceList } from "@/components/on-demand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { Workspace } from "@/lib/session";
import { RAIL_OVERLAP_PX } from "@/lib/sidebar-metrics";
import { useToast } from "@/lib/realtime";
import { useTransitionRouter } from "@/lib/view-transitions";
import { qk } from "@/lib/query-keys";
import { useInvalidate } from "@/lib/use-invalidate";
import { countLabel, deleteWorkspace, updateWorkspace } from "@/lib/workspace-api";

export type { Workspace };

/**
 * Switches between workspaces and creates new ones.
 *
 * A searchable list rather than a plain menu: most people have more than ten
 * workspaces, and scrolling a menu for the right one is slower than typing
 * the first few letters of its name.
 *
 * The active workspace is the one in the address, `/{ws}/…`, rather than
 * component state, so the server rendering the page and the switcher can
 * never show two different ones. Switching is going to the workspace's
 * address.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}) {
  const transitionRouter = useTransitionRouter();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /** The workspace whose Manage dialog is open. */
  const [managing, setManaging] = useState<Workspace | null>(null);
  /** The empty workspace whose deletion is being confirmed. */
  const [deleting, setDeleting] = useState<Workspace | null>(null);

  const live = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);
  const active = live.find((w) => w.id === activeWorkspaceId) ?? live[0] ?? workspaces[0];

  function select(workspace: { hash: string }) {
    transitionRouter.push(`/${workspace.hash}`);
  }

  /**
   * Leaving the workspace you are in moves you to the next one still in use,
   * so the page never renders against a workspace that is no longer listed.
   * With none left the server seeds a fresh one on the next read.
   */
  function leave(workspace: Workspace) {
    if (workspace.id !== active?.id) return;
    const next = live.find((w) => w.id !== workspace.id);
    transitionRouter.push(next ? `/${next.hash}` : "/");
  }

  async function setArchived(workspace: Workspace, archive: boolean) {
    try {
      await updateWorkspace(workspace.id, { archived: archive });
      if (archive) leave(workspace);
      invalidate(qk.bootstrap());
      toast({
        title: archive ? `Archived ${workspace.name}` : `Restored ${workspace.name}`,
        description: archive ? "Find it under Archived in the workspace list." : undefined,
      });
    } catch (e) {
      toast({
        title: archive ? "Could not archive" : "Could not restore",
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    }
  }

  /** The 3-dot menu on a row: Manage, then Archive -- or Delete when empty. */
  function rowMenu(workspace: Workspace) {
    const empty = workspace.projectCount === 0;
    // Somewhere has to remain to land in.
    const onlyOne = workspaces.length <= 1;
    const manage = workspace.permissions.includes("workspace.manage");
    const remove = workspace.permissions.includes("workspace.delete");
    // A member who can change nothing has nothing to open the menu for.
    if (!manage) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          // Inside a list item that selects on click: the menu's own clicks
          // must not reach it, or opening the menu would switch workspace.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:bg-background/60 hover:text-foreground aria-expanded:bg-background/60 grid size-6 shrink-0 place-items-center rounded-md opacity-0 transition-opacity group-hover/command-item:opacity-100 group-data-selected/command-item:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
        >
          <MoreHorizontalIcon className="size-4" />
          <span className="sr-only">More options for {workspace.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-44"
          side="right"
          align="start"
          // Portalled in the DOM but not in React, whose events still bubble
          // to the row: a click on Manage would select the workspace too,
          // and Enter would reach the list's own keyboard handling.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              setManaging(workspace);
            }}
          >
            <Settings2Icon className="text-muted-foreground" />
            <span>Manage</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {workspace.archived && (
            <DropdownMenuItem onClick={() => void setArchived(workspace, false)}>
              <ArchiveRestoreIcon className="text-muted-foreground" />
              <span>Unarchive</span>
            </DropdownMenuItem>
          )}
          {!workspace.archived && !empty && (
            <DropdownMenuItem onClick={() => void setArchived(workspace, true)}>
              <ArchiveIcon className="text-muted-foreground" />
              <span>Archive</span>
            </DropdownMenuItem>
          )}
          {empty && remove && (
            <DropdownMenuItem
              variant="destructive"
              disabled={onlyOne}
              onClick={() => {
                setOpen(false);
                setDeleting(workspace);
              }}
            >
              <Trash2Icon />
              <span>Delete</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
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
                  // See-through rather than the menu's solid hover, so the sky
                  // behind it stays visible: a thin tint and a hairline edge,
                  // held while the list is open. Base UI marks an open
                  // trigger with aria-expanded, not data-open.
                  className="hover:bg-sidebar/45 hover:text-sidebar-foreground hover:shadow-[inset_0_0_0_1px_var(--border-strong)] active:bg-sidebar/45 active:text-sidebar-foreground aria-expanded:bg-sidebar/45 aria-expanded:text-sidebar-foreground aria-expanded:shadow-[inset_0_0_0_1px_var(--border-strong)]"
                />
              }
            >
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active?.name ?? "No workspace"}</span>
                <span className="truncate text-xs">
                  {active ? countLabel(active) : "Create one to start"}
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
              <WorkspaceList
                live={live}
                archived={archived}
                activeId={active?.id}
                showArchived={showArchived}
                onToggleArchived={() => setShowArchived((v) => !v)}
                onSelect={(workspace) => {
                  setOpen(false);
                  select(workspace);
                }}
                onAdd={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                rowMenu={rowMenu}
              />
            </PopoverContent>
          </Popover>
        </SidebarMenuItem>
      </SidebarMenu>

      <NewWorkspaceDialog open={creating} onOpenChange={setCreating} onCreated={select} />

      <ManageWorkspaceDialog
        workspace={managing}
        open={managing !== null}
        onOpenChange={(next) => !next && setManaging(null)}
        onSaved={() => invalidate(qk.bootstrap())}
        onArchive={(workspace, archive) => void setArchived(workspace, archive)}
        onDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "workspace"}?`}
        description="It has nothing in it. The workspace itself is removed for good."
        onConfirm={async () => {
          if (!deleting) return;
          await deleteWorkspace(deleting.id);
          leave(deleting);
          invalidate(qk.bootstrap());
        }}
      />
    </>
  );
}
