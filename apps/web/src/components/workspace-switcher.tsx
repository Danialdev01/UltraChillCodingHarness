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
import type { Workspace } from "@/lib/session";
import { RAIL_OVERLAP_PX } from "@/lib/sidebar-metrics";
import { useToast } from "@/lib/realtime";
import { useTransitionRouter } from "@/lib/view-transitions";
import { qk } from "@/lib/query-keys";
import { useInvalidate } from "@/lib/use-invalidate";
import { deleteWorkspace, updateWorkspace } from "@/lib/workspace-api";

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
  open,
  onOpenChange: setOpen,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * Held by the sidebar, so the workspace logo at the top of the rail can
   * open this same list -- anchored here, under the name.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const transitionRouter = useTransitionRouter();
  const invalidate = useInvalidate();
  const toast = useToast();
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            // See-through rather than a solid hover, so the sky behind it
            // stays visible: the chevron brightens, the name stays put.
            <button
              type="button"
              role="combobox"
              aria-expanded={open}
              aria-label={`Workspace: ${active?.name ?? "none"}. Switch workspace`}
              className="group/ws focus-visible:ring-focus-ring -mx-1 flex min-w-0 flex-col items-start rounded-md px-1 text-left transition-colors duration-150 outline-none focus-visible:ring-2"
            />
          }
        >
          {/* The only uppercase text in the sidebar. */}
          <span className="text-text-subtle text-[10.5px] leading-4 tracking-[0.08em] uppercase">Workspace</span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <span className="text-sidebar-foreground truncate text-[15px] leading-5 font-semibold">
              {active?.name ?? "No workspace"}
            </span>
            <ChevronsUpDownIcon
              aria-hidden
              className="text-text-subtle group-hover/ws:text-sidebar-foreground group-aria-expanded/ws:text-sidebar-foreground size-3.5 shrink-0 transition-colors duration-150"
            />
          </span>
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
              className="w-(--ucch-sidebar-width) max-w-[100vw] min-w-56 p-0"
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
