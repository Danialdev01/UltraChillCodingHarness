"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon, PlusIcon } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { Workspace } from "@/lib/session";
import { countLabel } from "@/lib/workspace-api";

/**
 * The searchable list inside `WorkspaceSwitcher`'s popover: its own chunk
 * (`on-demand.tsx`), so cmdk is not part of every page's first load. The
 * switcher keeps the state and the actions; this draws the rows.
 */
export function WorkspaceList({
  live,
  archived,
  activeId,
  showArchived,
  onToggleArchived,
  onSelect,
  onAdd,
  rowMenu,
}: {
  live: Workspace[];
  archived: Workspace[];
  activeId: string | undefined;
  showArchived: boolean;
  onToggleArchived: () => void;
  onSelect: (workspace: Workspace) => void;
  onAdd: () => void;
  /** The 3-dot menu at the end of a row, or null when there is nothing in it. */
  rowMenu: (workspace: Workspace) => ReactNode;
}) {
  return (
    <Command>
      <CommandInput placeholder="Search workspaces…" />
      <CommandList>
        <CommandEmpty>No workspace matches that.</CommandEmpty>
        <CommandGroup>
          {live.map((workspace) => (
            <CommandItem
              key={workspace.id}
              // The name is what gets matched on; the id is appended
              // so two same-named workspaces stay distinct rows.
              value={`${workspace.name} ${workspace.id}`}
              keywords={[workspace.slug]}
              // The row's own tick, which `CommandItem` renders and
              // this is the switch for.
              data-checked={workspace.id === activeId}
              onSelect={() => onSelect(workspace)}
            >
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate">{workspace.name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {countLabel(workspace)}
                  {workspace.shared && ` · shared by ${workspace.ownerName} · ${workspace.role}`}
                </span>
              </div>
              {rowMenu(workspace)}
            </CommandItem>
          ))}
        </CommandGroup>

        {archived.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__archived"
                // A fold, not a workspace: shown whatever was typed,
                // and it never takes the tick.
                forceMount
                aria-expanded={showArchived}
                onSelect={onToggleArchived}
                className="text-muted-foreground text-xs"
              >
                <ChevronRightIcon
                  className={showArchived ? "rotate-90 transition-transform" : "transition-transform"}
                />
                Archived ({archived.length})
              </CommandItem>
              {showArchived &&
                archived.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={`${workspace.name} ${workspace.id}`}
                    keywords={[workspace.slug, "archived"]}
                    // An archived workspace is not somewhere to go;
                    // its menu restores it first.
                    onSelect={() => undefined}
                    className="text-muted-foreground"
                  >
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate">{workspace.name}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {countLabel(workspace)} · archived
                      </span>
                    </div>
                    {rowMenu(workspace)}
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        <CommandGroup>
          <CommandItem
            value="__add-workspace"
            // Always shown, whatever was typed: creating one is the
            // answer when the search finds nothing.
            forceMount
            onSelect={onAdd}
          >
            <PlusIcon />
            Add workspace
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
