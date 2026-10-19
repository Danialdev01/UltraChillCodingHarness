"use client";

import { useState } from "react";
import {
  DatabaseIcon,
  FolderGitIcon,
  ListTodoIcon,
  MessageSquarePlusIcon,
  StickyNoteIcon,
} from "lucide-react";

import { NewDatabaseDialog, NewProjectDialog, TaskDialog } from "@/components/on-demand";
import type { TaskDialogState } from "@/components/tasks/task-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project, Workspace } from "@/lib/session";
import { createTask, type TaskInput } from "@/lib/tasks-api";
import { useNewSession } from "@/lib/use-new-session";
import { cn } from "@/lib/utils";
import { projectPageHref } from "@/lib/sections";
import { useTransitionRouter } from "@/lib/view-transitions";
import { useWorkspaceHash } from "@/lib/workspace-context";

/**
 * One-tap creation for the things you add most often.
 *
 * "New todo" opens the same dialog as a Tasks board, with no project picked:
 * the dialog asks which one, and saving lands on that project's board.
 * Unavailable actions are rendered disabled with a tooltip saying so, rather
 * than omitted or wired to a no-op -- a button that looks live and silently
 * does nothing is the worst of the three options.
 */
export function QuickActions({
  workspaceId,
  projects,
  sessionWorkspace = false,
  permissions,
}: {
  workspaceId: string;
  projects: readonly Project[];
  /** A session workspace starts sessions where others start projects. */
  sessionWorkspace?: boolean;
  /** What the caller's role in the workspace allows. */
  permissions: Workspace["permissions"];
}) {
  // A session is a project with a thread in it, so starting one needs both.
  const canCreateProject = permissions.includes("project.create");
  const canStartSession = canCreateProject && permissions.includes("session.create");
  const canWrite = permissions.includes("project.write");
  const session = useNewSession(workspaceId);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [todo, setTodo] = useState<TaskDialogState>(null);
  const [saving, setSaving] = useState(false);
  const router = useTransitionRouter();
  const ws = useWorkspaceHash();

  async function saveTodo(input: TaskInput, projectHash: string) {
    setSaving(true);
    try {
      await createTask(projectHash, input);
      setTodo(null);
      router.push(projectPageHref(ws, projectHash, "tasks"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-4 gap-1">
        <Action
          icon={ListTodoIcon}
          label="New todo"
          onClick={() => setTodo({ mode: "create" })}
          unavailable={
            !canWrite
              ? "Your role in this workspace is read-only"
              : projects.length > 0
                ? undefined
                : sessionWorkspace
                  ? "Start a session to add a todo"
                  : "Create a project to add a todo"
          }
        />
        {sessionWorkspace ? (
          <Action
            icon={MessageSquarePlusIcon}
            label={session.pending ? "Starting a session…" : "New session"}
            onClick={session.start}
            unavailable={canStartSession ? undefined : "Your role cannot start sessions here"}
          />
        ) : (
          <Action
            icon={FolderGitIcon}
            label="New project"
            onClick={() => setCreating(true)}
            unavailable={canCreateProject ? undefined : "Your role cannot create projects here"}
          />
        )}
        <Action
          icon={DatabaseIcon}
          label="New database connection"
          onClick={() => setConnecting(true)}
          unavailable={permissions.includes("workspace.manage") ? undefined : "Only an admin can add connections"}
        />
        <Action
          icon={StickyNoteIcon}
          label="New note"
          unavailable="Notes arrive with the agent core"
        />
      </div>

      {/* Outside the grid: the dialogs render no element of their own, and a
          fifth child in a four-column grid is a trap for the next change. */}
      <NewProjectDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
      <NewDatabaseDialog workspaceId={workspaceId} open={connecting} onOpenChange={setConnecting} />
      <TaskDialog
        state={todo}
        projects={projects}
        busy={saving}
        onClose={() => setTodo(null)}
        onSave={saveTodo}
      />
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
