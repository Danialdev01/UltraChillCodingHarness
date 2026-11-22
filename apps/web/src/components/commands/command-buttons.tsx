"use client"

import * as React from "react"
import { PlusIcon, Settings2Icon } from "lucide-react"
import type { ProjectCommand } from "@ucch/protocol"

import { commandIcon } from "@/components/commands/command-icons"
import { useFilesPanel } from "@/components/files-panel"
import { ManageCommandsDialog } from "@/components/on-demand"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"

/**
 * The project's command buttons, from `.agent/commands.json`: the list, why
 * it could not be read when it could not, and a way to run one -- in a
 * terminal tab of its own, which switches to the terminal view.
 */
export function useProjectCommands(project: Project) {
  const query = projectQueries.commands(project.hash)
  const [data, , , state] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
    refetchInterval: 5000,
  })
  const { runCommand } = useFilesPanel()
  const commands = data?.commands ?? []
  const error = state.error?.message ?? data?.error ?? null
  const run = React.useCallback(
    (command: ProjectCommand) => runCommand(project.id, command.id, command.label),
    [runCommand, project.id],
  )
  return { commands, error, loaded: data !== undefined, run }
}

/**
 * The picker of the project's commands, opened from the run cluster's `›`
 * segment or with ⌘⇧P. Every command is here -- the ones the bar has no
 * room for too -- with what each is doing, and the way to add or change
 * them at the foot.
 */
export function CommandsMenu({
  project,
  open,
  onOpenChange,
  trigger,
  onSelect,
  decorate,
  managing: managingProp,
  onManagingChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The element that opens it; given the trigger's props by the menu. */
  trigger: React.ReactElement
  /** What picking a command does; runs it by default. */
  onSelect?: (command: ProjectCommand) => void
  /** A command's live state, drawn in its row: its mark, colour and a word. */
  decorate?: (command: ProjectCommand) => { icon: React.ReactNode; tone: string | null; state: string | null } | null
  /** Whether the editor is open, and whether to add a command or change them; held here when not given. */
  managing?: "add" | "edit" | null
  onManagingChange?: (managing: "add" | "edit" | null) => void
}) {
  const { commands, error, run } = useProjectCommands(project)
  const pick = onSelect ?? run
  const [ownManaging, setOwnManaging] = React.useState<"add" | "edit" | null>(null)
  const managing = managingProp !== undefined ? managingProp : ownManaging
  const setManaging = onManagingChange ?? setOwnManaging

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Commands</DropdownMenuLabel>
            {error && (
              <p role="alert" className="text-warning px-2 pb-1.5 text-xs leading-snug break-words">
                {error} Use .agent/commands.json with id, label, and command fields.
              </p>
            )}
            {commands.map((command) => {
              const Icon = commandIcon(command.icon)
              const live = decorate?.(command) ?? null
              return (
                <DropdownMenuItem key={command.id} onClick={() => pick(command)} className="group/seg">
                  <span className={cn("grid size-4 shrink-0 place-items-center", live?.tone)}>
                    {live ? live.icon : <Icon />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{command.label}</span>
                    <span className="text-muted-foreground truncate font-mono text-[11px]">{command.command}</span>
                  </span>
                  {live?.state && (
                    <span className={cn("shrink-0 font-mono text-[11px]", live.tone)}>{live.state}</span>
                  )}
                </DropdownMenuItem>
              )
            })}
            {commands.length === 0 && !error && (
              <p className="text-muted-foreground px-2 pb-1.5 text-xs leading-snug">
                No commands yet. Each one you add gets its own button in the bar, and runs in a terminal tab. They
                are kept in <code>.agent/commands.json</code>.
              </p>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setManaging(commands.length === 0 ? "add" : "edit")}>
            {commands.length === 0 ? <PlusIcon /> : <Settings2Icon />}
            {commands.length === 0 ? "Add a command" : "Manage commands"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ManageCommandsDialog
        project={project}
        open={managing !== null}
        onOpenChange={(open) => !open && setManaging(null)}
        commands={commands}
        adding={managing === "add"}
      />
    </>
  )
}
