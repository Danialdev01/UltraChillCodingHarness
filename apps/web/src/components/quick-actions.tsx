"use client";

import { useState } from "react";
import { BellIcon, FolderGitIcon, ListTodoIcon, StickyNoteIcon } from "lucide-react";

import { NewProjectDialog } from "@/components/new-project-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One-tap creation for the things you add most often.
 *
 * Only "project" has somewhere to store anything today. The other three are
 * rendered disabled with a tooltip saying so, rather than omitted or wired to
 * a no-op -- a button that looks live and silently does nothing is the worst
 * of the three options.
 */
export function QuickActions({ workspaceId }: { workspaceId: string }) {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="grid grid-cols-4 gap-1">
        <Action
          icon={ListTodoIcon}
          label="New todo"
          unavailable="Todos arrive with the agent core"
        />
        <Action icon={FolderGitIcon} label="New project" onClick={() => setCreating(true)} />
        <Action
          icon={BellIcon}
          label="New reminder"
          unavailable="Reminders arrive with the agent core"
        />
        <Action
          icon={StickyNoteIcon}
          label="New note"
          unavailable="Notes arrive with the agent core"
        />
      </div>

      {/* Outside the grid: the dialog renders no element of its own, and a
          fifth child in a four-column grid is a trap for the next change. */}
      <NewProjectDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
    </>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  unavailable,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  unavailable?: string;
}) {
  const disabled = Boolean(unavailable);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={cn(
              "text-muted-foreground focus-visible:ring-ring flex h-8 items-center justify-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none",
              disabled
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
          />
        }
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">{unavailable ?? label}</TooltipContent>
    </Tooltip>
  );
}
