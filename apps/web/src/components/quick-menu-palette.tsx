"use client";

import {
  CodeIcon,
  DatabaseIcon,
  FolderGitIcon,
  GitBranchIcon,
  ListTodoIcon,
  RocketIcon,
  StickyNoteIcon,
  LayersIcon,
  MessageSquarePlusIcon,
} from "lucide-react";

import { ProjectStackIcon } from "@/components/project-stack-icon";
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
import { countLabel } from "@/lib/workspace-api";
import { projectHref, sectionById, sectionHref } from "@/lib/sections";

/**
 * The command palette `QuickMenu` opens: its own chunk (`on-demand.tsx`), so
 * cmdk and the palette's rows are not part of every page's first load. The
 * menu keeps the state and the shortcut; this only draws the list and says
 * which row was chosen.
 */
export function QuickMenuPalette({
  open,
  onOpenChange,
  projects,
  workspaces,
  activeWorkspace,
  canStartSession,
  canCreateProject,
  canConnectDatabase,
  onNewSession,
  onNewProject,
  onNewDatabase,
  onNewWorkspace,
  onGo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  /** The workspaces that can be switched to. */
  workspaces: Workspace[];
  activeWorkspace: Workspace | undefined;
  canStartSession: boolean;
  canCreateProject: boolean;
  canConnectDatabase: boolean;
  onNewSession: () => void;
  onNewProject: () => void;
  onNewDatabase: () => void;
  onNewWorkspace: () => void;
  onGo: (href: string) => void;
}) {
  const sessionWorkspace = activeWorkspace?.kind === "session";
  const ws = activeWorkspace?.hash ?? "";

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick menu"
      description="Create something, or jump to a project or section."
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Create">
          {sessionWorkspace ? (
            canStartSession && (
              <CommandItem onSelect={onNewSession}>
                <MessageSquarePlusIcon />
                New session
              </CommandItem>
            )
          ) : (
            canCreateProject && <CommandItem onSelect={onNewProject}>
              <FolderGitIcon />
              New project
              <CommandShortcut>from a repository</CommandShortcut>
            </CommandItem>
          )}
          {canConnectDatabase && (
            <CommandItem onSelect={onNewDatabase}>
              <DatabaseIcon />
              New database connection
              <CommandShortcut>MySQL or PostgreSQL</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem onSelect={onNewWorkspace}>
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
                  onSelect={() => onGo(projectHref(ws, activeWorkspace?.kind ?? "project", project.hash))}
                >
                  <ProjectStackIcon stack={project.stack} />
                  {project.name}
                  <CommandShortcut>{project.stack}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {workspaces.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch workspace">
              {workspaces.map((workspace) => (
                <CommandItem
                  key={workspace.id}
                  value={`workspace ${workspace.name}`}
                  onSelect={() => onGo(`/${workspace.hash}`)}
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
          <CommandItem onSelect={() => onGo(sectionHref(sectionById("dashboard"), ws))}>
            <CodeIcon />
            Coding
          </CommandItem>
          <CommandItem onSelect={() => onGo(sectionHref(sectionById("database"), ws))}>
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
