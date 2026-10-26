"use client";

import { useCallback, useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";

import { NewDatabaseDialog, NewProjectDialog, NewWorkspaceDialog, QuickMenuPalette } from "@/components/on-demand";
import type { Project } from "@/lib/session";
import type { Workspace } from "@/components/workspace-switcher";
import { useNewSession } from "@/lib/use-new-session";
import { useTransitionRouter } from "@/lib/view-transitions";

/**
 * The search field and the command palette behind it.
 *
 * Everything reachable from the sidebar is reachable from here, which is what
 * makes it worth having: creating things, jumping between projects, and
 * switching workspaces without opening three different menus.
 *
 * Actions whose backend does not exist yet are shown but disabled rather than
 * hidden -- a palette that silently lacks half its verbs is more confusing
 * than one that says which are not ready.
 */
export function QuickMenu({
  projects,
  workspaces,
  activeWorkspaceId,
}: {
  projects: Project[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
}) {
  const router = useTransitionRouter();
  const [open, setOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [connectingDatabase, setConnectingDatabase] = useState(false);
  const session = useNewSession(activeWorkspaceId);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const permissions = activeWorkspace?.permissions ?? [];
  const canCreateProject = permissions.includes("project.create");
  const canStartSession = canCreateProject && permissions.includes("session.create");
  // Archived workspaces are restored from the switcher, not jumped to.
  const switchable = workspaces.filter((w) => !w.archived);

  // The conventional palette shortcut. Registered on the window so it works
  // wherever focus happens to be, except inside a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;
      event.preventDefault();
      setOpen((previous) => !previous);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const run = useCallback((action: () => void) => {
    setOpen(false);
    action();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-md border px-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="bg-muted text-muted-foreground pointer-events-none hidden rounded border px-1.5 font-mono text-[10px] sm:inline-block">
          ⌘K
        </kbd>
      </button>

      <QuickMenuPalette
        open={open}
        onOpenChange={setOpen}
        projects={projects}
        workspaces={switchable}
        activeWorkspace={activeWorkspace}
        canStartSession={canStartSession}
        canCreateProject={canCreateProject}
        canConnectDatabase={permissions.includes("workspace.manage")}
        onNewSession={() => run(session.start)}
        onNewProject={() => run(() => setCreatingProject(true))}
        onNewDatabase={() => run(() => setConnectingDatabase(true))}
        onNewWorkspace={() => run(() => setCreatingWorkspace(true))}
        onGo={(href) => run(() => router.push(href))}
      />

      <NewProjectDialog
        workspaceId={activeWorkspaceId}
        open={creatingProject}
        onOpenChange={setCreatingProject}
      />

      <NewDatabaseDialog
        workspaceId={activeWorkspaceId}
        open={connectingDatabase}
        onOpenChange={setConnectingDatabase}
      />

      <NewWorkspaceDialog
        open={creatingWorkspace}
        onOpenChange={setCreatingWorkspace}
        onCreated={(workspace) => router.push(`/${workspace.hash}`)}
      />
    </>
  );
}
