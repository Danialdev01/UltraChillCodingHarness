"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon, Loader2Icon, SquareIcon } from "lucide-react"
import type { ProjectCommand } from "@ucch/protocol"

import { CommandsMenu, useProjectCommands } from "@/components/commands/command-buttons"
import { commandIcon } from "@/components/commands/command-icons"
import { Hint, isCommandKey, shortcut, useIsMac } from "@/components/topbar/primitives"
import { fetchPreviewStatus } from "@/lib/preview-api"
import { qk } from "@/lib/query-keys"
import { useProjectEvents, useRealtime } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { fetchProjectTerminals, type ProjectTerminal } from "@/lib/terminal-api"
import { cn } from "@/lib/utils"

export type RunState = "stopped" | "starting" | "running" | "error"

/** One command's live state, as a segment and the picker show it. */
export interface CommandRun {
  command: ProjectCommand
  state: RunState
  /** The dev server's port, once something answers on it. */
  port: number | null
  /** Whether this is the project's dev server: it gets the dot and the port. */
  server: boolean
}

/** How long a click is "starting" before the server has listed the tab. */
const PENDING_MS = 15_000
/** How long a dev server with a preview port is "starting" before it answers on it. */
const BOOT_MS = 30_000

/**
 * Exit statuses that are the user stopping it, not it failing: ctrl-C
 * (SIGINT, 130), SIGTERM (143) and a hang-up (129).
 */
const STOPPED_BY_HAND = new Set([0, 129, 130, 143])

/**
 * Which command is the dev server: by id first, then a play icon, then its
 * label. It leads the cluster and is the one whose port is shown.
 */
function pickServer(commands: readonly ProjectCommand[]): ProjectCommand | null {
  const ids = ["dev", "start", "serve", "dev-server", "run-dev"]
  return (
    ids.map((id) => commands.find((c) => c.id === id)).find(Boolean) ??
    commands.find((c) => c.icon === "play") ??
    commands.find((c) => /\b(dev|serve|start)\b/i.test(c.label)) ??
    null
  )
}

/** The newest terminal running each command, of the caller's in this project. */
function newestByCommand(terminals: readonly ProjectTerminal[]): Map<string, ProjectTerminal> {
  const found = new Map<string, ProjectTerminal>()
  for (const t of terminals) {
    if (t.program !== "command" || !t.commandId) continue
    const seen = found.get(t.commandId)
    if (!seen || t.createdAt > seen.createdAt) found.set(t.commandId, t)
  }
  return found
}

/** A re-render at `at`, for states that change with time alone. */
function useWakeAt(at: number | null) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (at === null) return
    const timer = setTimeout(tick, Math.max(0, at - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [at])
}

/**
 * What each of the project's commands is doing, and the means to start and
 * stop them.
 *
 * Read from the caller's terminals in the project (`GET .../terminals`): a
 * command's tab says which command it runs and, once the shell has marked
 * the command's end, how it exited. The server nudges this list
 * (`resource.changed{terminals}`) as tabs open and close and as a command
 * ends, so the cluster follows without polling. The dev server counts as up
 * once something answers on the preview port (`port.opened`).
 */
export function useCommandRuns(project: Project) {
  const { commands, loaded, run } = useProjectCommands(project)
  const { client } = useRealtime()
  const server = pickServer(commands)

  const { data } = useQuery({
    queryKey: qk.terminals.list(project.id),
    queryFn: () => fetchProjectTerminals(project.id),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
    retry: false,
    enabled: commands.length > 0,
  })
  const latest = React.useMemo(() => newestByCommand(data?.terminals ?? []), [data])

  // Whether the dev server answers on the preview port.
  const port = server && project.previewStaticDir == null ? (project.previewPort ?? null) : null
  const [listening, setListening] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    if (!port) {
      setListening(null)
      return
    }
    let cancelled = false
    fetchPreviewStatus(project.hash)
      .then((s) => !cancelled && setListening(s.listening))
      .catch(() => !cancelled && setListening(null))
    return () => {
      cancelled = true
    }
  }, [project.hash, port])
  useProjectEvents(port ? project.id : null, (event) => {
    if ((event.type === "port.opened" || event.type === "port.closed") && event.port === port) {
      setListening(event.type === "port.opened")
    }
  })

  // A click waits for its tab to be listed; until then the segment says it is starting.
  const [pending, setPending] = React.useState<Record<string, number>>({})
  const now = Date.now()
  const wakes: number[] = []

  const runs: CommandRun[] = commands.map((command) => {
    const term = latest.get(command.id) ?? null
    const since = pending[command.id]
    const isServer = command.id === server?.id
    const waiting =
      since !== undefined && now - since < PENDING_MS && !(term && Date.parse(term.createdAt) >= since - 2_000)
    if (since !== undefined && waiting) wakes.push(since + PENDING_MS)

    let state: RunState = "stopped"
    if (waiting) state = "starting"
    else if (term && term.commandExit == null) {
      state = "running"
      // A dev server with a port is still starting until the port answers -- for a while.
      if (isServer && port && !listening) {
        const until = Date.parse(term.createdAt) + BOOT_MS
        if (now < until) {
          state = "starting"
          wakes.push(until)
        }
      }
    } else if (term && term.commandExit != null && !STOPPED_BY_HAND.has(term.commandExit)) state = "error"

    return { command, state, server: isServer, port: isServer && state === "running" && port && listening ? port : null }
  })
  useWakeAt(wakes.filter((t) => t > now).sort((a, b) => a - b)[0] ?? null)

  // The dev server first; the rest in the file's order.
  runs.sort((a, b) => Number(b.server) - Number(a.server))

  const close = React.useCallback(
    (terminal: ProjectTerminal) => void client?.dispatch({ type: "terminal.close", terminalId: terminal.id }).catch(() => {}),
    [client],
  )

  /** Starts a command, or stops it while it runs. A finished tab of its last run goes first, so they do not pile up. */
  const toggle = (command: ProjectCommand) => {
    const term = latest.get(command.id) ?? null
    if (term && term.commandExit == null) {
      close(term)
      setPending(({ [command.id]: _, ...rest }) => rest)
      return
    }
    if (term) close(term)
    setPending((p) => ({ ...p, [command.id]: Date.now() }))
    run(command)
  }

  return { runs, loaded, toggle }
}

const SEGMENT =
  "focus-visible:ring-focus-ring/60 group/seg flex shrink-0 items-center justify-center gap-1.5 px-2 text-[13px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset"

const LOOK: Record<RunState, string> = {
  stopped: "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
  starting: "bg-warning/10 text-warning",
  running: "bg-success/10 text-success hover:bg-success/15",
  error: "bg-danger/10 text-danger hover:bg-danger/15",
}

/** A state's colour and word in the picker's rows; nothing at rest. */
const PICKER: Record<RunState, { tone: string; word: string } | null> = {
  stopped: null,
  starting: { tone: "text-warning", word: "starting" },
  running: { tone: "text-success", word: "running" },
  error: { tone: "text-danger", word: "failed" },
}

/**
 * How many segments the bar has room for, by the bar's own width: the
 * first always, then one more at each step. The rest are in the picker.
 * Literal strings, so Tailwind sees every class.
 */
const FITS = ["flex", "hidden @xl:flex", "hidden @3xl:flex", "hidden @5xl:flex", "hidden @7xl:flex"]

function describe(run: CommandRun): string {
  const name = run.command.label
  switch (run.state) {
    case "stopped":
      return `Run ${name}`
    case "starting":
      return `${name} starting`
    case "running":
      return run.port ? `Stop ${name} (running on port ${run.port})` : `Stop ${name} (running)`
    case "error":
      return `${name} failed, run again`
  }
}

/**
 * The project's commands, joined into one control: what used to be a
 * second row under the bar.
 *
 * One segment per command in `.agent/commands.json` -- its own icon, and
 * what its process is doing: starting, running (stop on hover), or failed.
 * The dev server leads, with its label and, once it answers, its port.
 * Segments the bar has no room for fold into the `›` picker, which lists
 * every command and is where they are added. With no commands, there is
 * nothing here at all; ⌘⇧P still opens the picker to add one.
 */
export function RunCluster({ project }: { project: Project }) {
  const mac = useIsMac()
  const { runs, loaded, toggle } = useCommandRuns(project)
  const [menuOpen, setMenuOpen] = React.useState(false)

  // ⌘⇧P, anywhere: the picker, as an editor's command palette is.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isCommandKey(event, { shift: true }) || event.key.toLowerCase() !== "p" || event.defaultPrevented) return
      event.preventDefault()
      setMenuOpen((open) => !open)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useRunAnnouncements(runs)

  const empty = runs.length === 0
  const picker = (
    <CommandsMenu
      project={project}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onSelect={toggle}
      decorate={(command) => {
        const run = runs.find((r) => r.command.id === command.id)
        if (!run) return null
        const look = PICKER[run.state]
        return {
          icon: <RunGlyph run={run} />,
          tone: look?.tone ?? null,
          state: run.port ? `:${run.port}` : (look?.word ?? null),
        }
      }}
      trigger={
        <button
          type="button"
          aria-label="Commands"
          title={`Commands  ${shortcut(mac, "P", true)}`}
          aria-keyshortcuts={mac ? "Meta+Shift+P" : "Control+Shift+P"}
          // With nothing to show the picker still needs somewhere to open from.
          className={cn(
            empty
              ? "pointer-events-none size-0 overflow-hidden"
              : cn(SEGMENT, LOOK.stopped, "aria-expanded:bg-muted aria-expanded:text-foreground"),
          )}
          tabIndex={empty ? -1 : undefined}
          aria-hidden={empty || undefined}
        >
          {!empty && <ChevronRightIcon className="size-3.5" />}
        </button>
      }
    />
  )

  // Nothing until the list is read, and nothing when it is empty: no
  // buttons for commands the project does not have.
  if (empty) return loaded ? picker : null

  return (
    <div
      role="group"
      aria-label="Commands"
      className="border-border light:border-border-strong divide-border light:divide-border-strong flex h-8 min-w-0 shrink-0 items-stretch divide-x overflow-hidden rounded-[9px] border"
    >
      {runs.slice(0, FITS.length).map((run, i) => (
        <Segment key={run.command.id} run={run} lead={i === 0} className={FITS[i]} onClick={() => toggle(run.command)} />
      ))}
      {picker}
    </div>
  )
}

function Segment({
  run,
  lead,
  className,
  onClick,
}: {
  run: CommandRun
  lead: boolean
  className?: string
  onClick: () => void
}) {
  const label = describe(run)
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(SEGMENT, LOOK[run.state], lead && "px-2.5", className)}
      >
        <RunGlyph run={run} />
        {/* The lead segment names itself once the bar has room; the rest
            are their icons, named by the tooltip. */}
        {lead && <span className="hidden max-w-28 truncate @xl:inline">{run.command.label}</span>}
        {lead && run.port && <span className="hidden font-mono text-[11px] @xl:inline">:{run.port}</span>}
      </button>
    </Hint>
  )
}

/**
 * A segment's mark: the command's own icon at rest or failed, a spinner
 * while it starts, and while it runs a dot (the dev server) or a spinner
 * (a task) that turns into stop under the pointer.
 */
export function RunGlyph({ run }: { run: CommandRun }) {
  const Icon = commandIcon(run.command.icon)
  if (run.state === "starting") return <Loader2Icon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
  if (run.state === "running") {
    return (
      <span className="grid size-3.5 shrink-0 place-items-center">
        {run.server ? (
          <span className="bg-success size-1.5 rounded-full group-hover/seg:hidden group-focus-visible/seg:hidden" />
        ) : (
          <Loader2Icon className="size-3.5 animate-spin group-hover/seg:hidden group-focus-visible/seg:hidden motion-reduce:animate-none" />
        )}
        <SquareIcon className="hidden size-3 fill-current group-hover/seg:block group-focus-visible/seg:block" />
      </span>
    )
  }
  return <Icon className="size-3.5 shrink-0" />
}

/** Says the moments that matter -- up, failed, finished -- to a screen reader, once each. */
function useRunAnnouncements(runs: readonly CommandRun[]) {
  const last = React.useRef(new Map<string, RunState>())
  const key = runs.map((r) => `${r.command.id}:${r.state}:${r.port ?? ""}`).join("|")
  React.useEffect(() => {
    const before = last.current
    const next = new Map<string, RunState>()
    for (const run of runs) {
      next.set(run.command.id, run.state)
      const was = before.get(run.command.id)
      if (was === undefined || was === run.state) continue
      const name = run.command.label
      if (run.state === "error") announce(`${name} failed`)
      else if (run.state === "running" && run.server) announce(run.port ? `${name} running on port ${run.port}` : `${name} running`)
      else if (run.state === "stopped" && (was === "running" || was === "starting")) {
        announce(run.server ? `${name} stopped` : `${name} finished`)
      }
    }
    last.current = next
    // `key` stands for `runs`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/** The bar's one polite live region, made on first use. */
function announce(message: string) {
  let region = document.getElementById("ucch-run-status")
  if (!region) {
    region = document.createElement("div")
    region.id = "ucch-run-status"
    region.setAttribute("role", "status")
    region.setAttribute("aria-live", "polite")
    region.className = "sr-only"
    document.body.appendChild(region)
  }
  // Cleared first, so the same message twice is still read twice.
  region.textContent = ""
  const target = region
  requestAnimationFrame(() => {
    target.textContent = message
  })
}
