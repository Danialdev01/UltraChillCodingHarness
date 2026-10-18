"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CodeIcon,
  DatabaseIcon,
  FolderGitIcon,
  GitBranchIcon,
  ListTodoIcon,
  RocketIcon,
  SearchIcon,
  StickyNoteIcon,
  LayersIcon,
  MessageSquarePlusIcon,
} from "lucide-react";

import { NewDatabaseDialog } from "@/components/new-database-dialog";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { ProjectStackIcon } from "@/components/project-stack-icon";
import { NewWorkspaceDialog } from "@/components/new-workspace-dialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type { Project } from "@/lib/session";
import type { Workspace } from "@/components/workspace-switcher";
import { useNewSession } from "@/lib/use-new-session";
import { countLabel } from "@/lib/workspace-api";
import { projectHref, sectionById, sectionHref } from "@/lib/sections";
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
  const sessionWorkspace = activeWorkspace?.kind === "session";
  const permissions = activeWorkspace?.permissions ?? [];
  const canCreateProject = permissions.includes("project.create");
  const canStartSession = canCreateProject && permissions.includes("session.create");
  // Archived workspaces are restored from the switcher, not jumped to.
  const switchable = workspaces.filter((w) => !w.archived);
  const ws = activeWorkspace?.hash ?? "";

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

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Quick menu"
        description="Create something, or jump to a project or section."
      >
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Create">
            {sessionWorkspace ? (
              canStartSession && (
                <CommandItem onSelect={() => run(session.start)}>
                  <MessageSquarePlusIcon />
                  New session
                </CommandItem>
              )
            ) : (
              canCreateProject && <CommandItem onSelect={() => run(() => setCreatingProject(true))}>
                <FolderGitIcon />
                New project
                <CommandShortcut>from a repository</CommandShortcut>
              </CommandItem>
            )}
            {permissions.includes("workspace.manage") && (
              <CommandItem onSelect={() => run(() => setConnectingDatabase(true))}>
                <DatabaseIcon />
                New database connection
                <CommandShortcut>MySQL or PostgreSQL</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem onSelect={() => run(() => setCreatingWorkspace(true))}>
              <LayersIcon />
              New workspace
            </CommandItem>
            {UNBUILT.map((item) => (
              <CommandItem key={item.label} disabled>
                <item.icon />
                {item.label}
                <CommandShortcut>{item.note}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          {projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={sessionWorkspace ? "Sessions" : "Projects"}>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`project ${project.name} ${project.hash}`}
                    onSelect={() => run(() => router.push(projectHref(ws, activeWorkspace?.kind ?? "project", project.hash)))}
                  >
                    <ProjectStackIcon stack={project.stack} />
                    {project.name}
                    <CommandShortcut>{project.stack}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {switchable.length > 1 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Switch workspace">
                {switchable.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={`workspace ${workspace.name}`}
                    onSelect={() =>
                      run(() => router.push(`/${workspace.hash}`))
                    }
                  >
                    <LayersIcon />
                    {workspace.name}
                    <CommandShortcut>{countLabel(workspace)}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => run(() => router.push(sectionHref(sectionById("dashboard"), ws)))}>
              <CodeIcon />
              Coding
            </CommandItem>
            <CommandItem onSelect={() => run(() => router.push(sectionHref(sectionById("database"), ws)))}>
              <DatabaseIcon />
              Database
            </CommandItem>
            {SECTION_LINKS.map((section) => (
              <CommandItem key={section.label} disabled>
                <section.icon />
                {section.label}
                <CommandShortcut>{section.note}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

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

/** Create actions whose storage does not exist yet. */
const UNBUILT = [
  { label: "New todo", icon: ListTodoIcon, note: "with the agent core" },
  { label: "New note", icon: StickyNoteIcon, note: "with the agent core" },
] as const;

const SECTION_LINKS = [
  { label: "Git", icon: GitBranchIcon, note: "with git integration" },
  { label: "Publish", icon: RocketIcon, note: "with previews" },
  { label: "Todo", icon: ListTodoIcon, note: "with the agent core" },
] as const;

