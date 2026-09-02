"use client"

import Link from "next/link"
import { FolderGitIcon } from "lucide-react"

import { SECTIONS, type SectionId } from "@/components/app-sidebar"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import type { Project } from "@/lib/session"

/**
 * The contents of the sidebar's second column, chosen by the active icon.
 *
 * Only Coding has real contents today -- it lists the workspace's projects.
 * The other four describe what they will hold rather than rendering fake
 * rows, so the shell never implies a feature that does not exist yet.
 */
export function SectionPanel({
  section,
  projects,
  activeProjectHash,
}: {
  section: SectionId
  projects: Project[]
  activeProjectHash?: string
}) {
  const title = SECTIONS.find((s) => s.id === section)?.title ?? "Section"

  if (section === "coding") {
    return (
      <SidebarGroup className="px-0">
        <SidebarGroupLabel className="px-4">Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          {projects.length === 0 ? (
            <p className="text-muted-foreground px-4 py-2 text-sm">
              No projects in this workspace yet. Clone a repository to start.
            </p>
          ) : (
            <SidebarMenu className="px-2">
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={project.hash === activeProjectHash}
                    render={<Link href={`/${project.hash}`} />}
                  >
                    <FolderGitIcon />
                    <div className="grid flex-1 leading-tight">
                      <span className="truncate">{project.name}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {project.stack === "unknown" ? "detecting…" : project.stack}
                        {" · "}
                        {project.containerState}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  return (
    <SidebarGroup className="px-0">
      <SidebarGroupLabel className="px-4">{title}</SidebarGroupLabel>
      <SidebarGroupContent>
        <p className="text-muted-foreground px-4 py-2 text-sm">{PLACEHOLDER[section]}</p>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * Honest descriptions rather than mock rows: each says what the section will
 * hold and which phase builds it.
 */
const PLACEHOLDER: Record<Exclude<SectionId, "coding">, string> = {
  database: "Migrations, seeders, and a table browser for the project database. Arrives with the container runtime.",
  git: "Changed files, staged diffs, commits, and branches. Arrives with the git integration.",
  publish: "Published previews and their shareable URLs, with expiry. Arrives with previews.",
  todo: "Tasks the agent has planned or completed across this workspace. Arrives with the agent core.",
}
