"use client"

import { ChevronRightIcon, EllipsisIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

import { ProjectStackIcon } from "@/components/project-stack-icon"
import type { SidebarProject } from "@/lib/session-sidebar"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * A project's header in the grouped list: its mark and name (a link to the
 * project), how many sessions it has, a chevron that folds its sessions
 * away, and a menu for managing or deleting it. Session workspaces keep
 * their new-session shortcut.
 */
export function ProjectGroupHeader({
  project,
  count,
  open,
  onToggle,
  onNewSession,
  href,
  isActive,
  onNavigate,
  onManage,
  onDelete,
}: {
  project: SidebarProject
  count: number
  open: boolean
  onToggle: () => void
  /** Absent when the caller's role cannot start one. */
  onNewSession?: () => void
  href: string
  isActive?: boolean
  onNavigate?: () => void
  onManage?: () => void
  onDelete?: () => void
}) {
  const action =
    "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
  return (
    <div className="group/project flex h-8 items-center gap-0.5 pr-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
        className={action}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <TransitionLink
        href={href}
        onClick={onNavigate}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "focus-visible:ring-sidebar-ring flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-sm outline-none focus-visible:ring-2",
          isActive ? "text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4" aria-hidden>
          <ProjectStackIcon stack={project.stack} />
        </span>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="text-muted-foreground text-2xs tabular-nums" aria-label={`${count} sessions`}>
          {count}
        </span>
      </TransitionLink>
      {onManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`Options for ${project.name}`} className={action}>
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onManage}><Settings2Icon />Manage</DropdownMenuItem>
            {onDelete && <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete Project</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : onNewSession && (
        <button
          type="button"
          onClick={onNewSession}
          aria-label={`New session in ${project.name}`}
          title={`New session in ${project.name}`}
          className={cn(
            action,
            "pointer-fine:opacity-0 pointer-fine:group-hover/project:opacity-100 pointer-fine:focus-visible:opacity-100",
          )}
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
