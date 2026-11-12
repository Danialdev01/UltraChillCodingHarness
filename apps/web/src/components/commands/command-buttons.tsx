"use client"

import * as React from "react"
import { PlusIcon, Settings2Icon, TriangleAlertIcon, TerminalIcon } from "lucide-react"

import { commandIcon } from "@/components/commands/command-icons"
import { useFilesPanel } from "@/components/files-panel"
import { ManageCommandsDialog } from "@/components/on-demand"
import { Button } from "@/components/ui/button"
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

/** Buttons shown in the bar itself; the rest are in the menu after them. */
const SHOWN = 3

/**
 * The project's command buttons, from `.agent/commands.json`, in the header.
 *
 * A click switches to the terminal view and opens a tab running that
 * command; the server reads the command line from the file. The menu at the
 * end holds the overflow and the way to add or change them.
 */
export function CommandButtons({ project }: { project: Project }) {
  const query = projectQueries.commands(project.hash)
  const [data, , , state] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
    refetchInterval: 5000,
  })
  const { runCommand } = useFilesPanel()
  const [managing, setManaging] = React.useState(false)

  const commands = data?.commands ?? []
  const shown = commands.slice(0, SHOWN)
  const error = state.error?.message ?? data?.error
  const run = (id: string, label: string) => runCommand(project.id, id, label)

  return (
    <>
      <div role="group" aria-label="Run commands" className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {shown.map((command) => {
          const Icon = commandIcon(command.icon)
          return (
            <Button
              key={command.id}
              variant="ghost"
              size="sm"
              title={`${command.description ? `${command.description}\n` : ""}$ ${command.command}`}
              onClick={() => run(command.id, command.label)}
              className="text-muted-foreground hover:text-foreground h-7 max-w-40 shrink-0 gap-1.5 px-2"
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate text-xs">{command.label}</span>
            </Button>
          )
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={error ? `Commands: ${error}` : "Manage project commands"}
          className="text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:bg-muted flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors"
        >
          {error ? <TriangleAlertIcon className="text-warning size-4" /> : <TerminalIcon className="size-4" />}
          <span>Commands</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Commands</DropdownMenuLabel>
            {error && (
              <p role="alert" className="text-warning break-words px-2 pb-1.5 text-xs leading-snug">{error}</p>
            )}
            {/* Repeat all commands here so overflow remains reachable on narrow screens. */}
            {commands.map((command) => {
              const Icon = commandIcon(command.icon)
              return (
                <DropdownMenuItem
                  key={command.id}
                  onClick={() => run(command.id, command.label)}
                >
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
                Buttons that run a command in a terminal tab, kept in <code>.agent/commands.json</code>.
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
      {error && <p role="alert" className="w-full text-xs text-warning break-words">{error} Use .agent/commands.json with id, label, and command fields.</p>}
      {!data && state.fetching && <span role="status" className="text-muted-foreground text-xs">Loading commands…</span>}
      <ManageCommandsDialog project={project} open={managing} onOpenChange={setManaging} commands={commands} />
    </>
  )
}
