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
 * segment or with ⌘⇧P. Every command is here, Dev and Build included, with
 * the way to add or change them at the foot.
 */
export function CommandsMenu({
  project,
  open,
  onOpenChange,
  trigger,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The element that opens it; given the trigger's props by the menu. */
  trigger: React.ReactElement
}) {
  const { commands, error, run } = useProjectCommands(project)
  const [managing, setManaging] = React.useState(false)

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
              return (
                <DropdownMenuItem key={command.id} onClick={() => run(command)}>
                  <Icon />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{command.label}</span>
                    <span className="text-muted-foreground truncate font-mono text-[11px]">{command.command}</span>
                  </span>
                </DropdownMenuItem>
              )
            })}
            {commands.length === 0 && !error && (
              <p className="text-muted-foreground px-2 pb-1.5 text-xs leading-snug">
                Commands that run in a terminal tab, kept in <code>.agent/commands.json</code>. One with the id{" "}
                <code>dev</code> becomes the Dev button, and <code>build</code> the Build button.
              </p>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setManaging(true)}>
            {commands.length === 0 ? <PlusIcon /> : <Settings2Icon />}
            {commands.length === 0 ? "Add a command" : "Manage commands"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ManageCommandsDialog project={project} open={managing} onOpenChange={setManaging} commands={commands} />
    </>
  )
}
