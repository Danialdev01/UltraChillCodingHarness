"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon, HammerIcon, Loader2Icon, PlayIcon, SquareIcon } from "lucide-react"
import type { ProjectCommand } from "@ucch/protocol"

import { CommandsMenu, useProjectCommands } from "@/components/commands/command-buttons"
import { useFilesPanel } from "@/components/files-panel"
import { Hint, isCommandKey, shortcut, useIsMac } from "@/components/topbar/primitives"
import { fetchPreviewStatus } from "@/lib/preview-api"
import { qk } from "@/lib/query-keys"
import { useProjectEvents, useRealtime } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { fetchProjectTerminals, type ProjectTerminal } from "@/lib/terminal-api"
import { cn } from "@/lib/utils"

export type RunState = "stopped" | "starting" | "running" | "error"

/** How long a click is "starting" before the server has listed the tab. */
const PENDING_MS = 15_000
/** How long a dev server with a preview port is "starting" before it answers on it. */
const BOOT_MS = 30_000

/**
 * Exit statuses that are the user stopping it, not it failing: ctrl-C
 * (SIGINT, 130), SIGTERM (143) and a hang-up (129).
 */
const STOPPED_BY_HAND = new Set([0, 129, 130, 143])

/** The commands that are the Dev and Build buttons: by id first, then icon, then label. */
function pick(commands: readonly ProjectCommand[], kind: "dev" | "build"): ProjectCommand | null {
  const ids = kind === "dev" ? ["dev", "start", "serve", "dev-server", "run-dev"] : ["build"]
  const icon = kind === "dev" ? "play" : "hammer"
  const label = kind === "dev" ? /\b(dev|serve|start)\b/i : /\bbuild\b/i
  return (
    ids.map((id) => commands.find((c) => c.id === id)).find(Boolean) ??
    commands.find((c) => c.icon === icon) ??
    commands.find((c) => label.test(c.label)) ??
    null
  )
}

/** The newest terminal running `command`, of the caller's in this project. */
function newest(terminals: readonly ProjectTerminal[], command: ProjectCommand | null): ProjectTerminal | null {
  if (!command) return null
  let found: ProjectTerminal | null = null
  for (const t of terminals) {
    if (t.program === "command" && t.commandId === command.id && (!found || t.createdAt > found.createdAt)) found = t
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
 * What the project's Dev and Build commands are doing, and the means to
 * start and stop them.
 *
 * Read from the caller's terminals in the project (`GET .../terminals`):
 * a command button's tab says which command it runs and, once the shell
 * has marked the command's end, how it exited. The server nudges this
 * list (`resource.changed{terminals}`) as tabs open and close and as a
 * command ends, so the buttons follow without polling. A dev server with
 * a preview port counts as up once something answers on that port -- the
 * server's port watcher says so (`port.opened`).
 */
export function useRunState(project: Project) {
  const { commands, run } = useProjectCommands(project)
  const { setMode } = useFilesPanel()
  const { client } = useRealtime()
  const dev = pick(commands, "dev")
  const build = pick(commands, "build")

  const { data } = useQuery({
    queryKey: qk.terminals.list(project.id),
    queryFn: () => fetchProjectTerminals(project.id),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const terminals = data?.terminals ?? []
  const devTerm = newest(terminals, dev)
  const buildTerm = newest(terminals, build)

  // Whether the dev server answers on the preview port.
  const port = project.previewStaticDir == null ? (project.previewPort ?? null) : null
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

  // A click waits for its tab to be listed; until then the button says it is starting.
  const [pending, setPending] = React.useState<{ dev: number | null; build: number | null }>({ dev: null, build: null })
  const now = Date.now()
  const devPending = pending.dev !== null && now - pending.dev < PENDING_MS && !(devTerm && Date.parse(devTerm.createdAt) >= pending.dev - 2_000)
  const buildPending =
    pending.build !== null && now - pending.build < PENDING_MS && !(buildTerm && Date.parse(buildTerm.createdAt) >= pending.build - 2_000)

  const devBootUntil = devTerm && devTerm.commandExit == null && port && !listening ? Date.parse(devTerm.createdAt) + BOOT_MS : null
  useWakeAt(
    [devBootUntil, pending.dev && pending.dev + PENDING_MS, pending.build && pending.build + PENDING_MS]
      .filter((t): t is number => typeof t === "number" && t > now)
      .sort((a, b) => a - b)[0] ?? null,
  )

  let devState: RunState = "stopped"
  if (devPending) devState = "starting"
  else if (devTerm && devTerm.commandExit == null) {
    devState = devBootUntil !== null && now < devBootUntil ? "starting" : "running"
  } else if (devTerm && devTerm.commandExit != null && !STOPPED_BY_HAND.has(devTerm.commandExit)) devState = "error"

  let buildState: RunState = "stopped"
  if (buildPending) buildState = "starting"
  else if (buildTerm && buildTerm.commandExit == null) buildState = "running"
  else if (buildTerm && buildTerm.commandExit != null && buildTerm.commandExit !== 0) buildState = "error"

  const close = React.useCallback(
    (terminal: ProjectTerminal) => void client?.dispatch({ type: "terminal.close", terminalId: terminal.id }).catch(() => {}),
    [client],
  )

  /** Runs a command afresh: the finished tab of its last run goes, so they do not pile up. */
  const start = (kind: "dev" | "build", command: ProjectCommand, last: ProjectTerminal | null) => {
    if (last && last.commandExit != null) close(last)
    setPending((p) => ({ ...p, [kind]: Date.now() }))
    run(command)
  }

  return {
    dev: {
      command: dev,
      state: devState,
      port: devState === "running" && port && listening ? port : null,
      toggle: () => {
        if (!dev) return false
        if (devTerm && devTerm.commandExit == null) {
          close(devTerm)
          setPending((p) => ({ ...p, dev: null }))
        } else start("dev", dev, devTerm)
        return true
      },
    },
    build: {
      command: build,
      state: buildState,
      run: () => {
        if (!build) return false
        // Already building: show it rather than start a second.
        if (buildState === "running" || buildState === "starting") setMode("terminal")
        else start("build", build, buildTerm)
        return true
      },
    },
  }
}

const SEGMENT = cn(
  "focus-visible:ring-focus-ring/60 flex items-center justify-center transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset",
)
const QUIET_SEGMENT = cn(SEGMENT, "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 px-2")

const DEV_LOOK: Record<RunState, string> = {
  stopped: "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
  starting: "bg-warning/10 text-warning",
  running: "bg-success/10 text-success hover:bg-success/15",
  error: "bg-danger/10 text-danger hover:bg-danger/15",
}

function devLabel(state: RunState, port: number | null, missing: boolean): string {
  if (missing) return "Add a dev command"
  switch (state) {
    case "stopped":
      return "Start dev server"
    case "starting":
      return "Dev server starting"
    case "running":
      return port ? `Stop dev server (running on port ${port})` : "Stop dev server (running)"
    case "error":
      return "Dev server failed, retry"
  }
}

/**
 * Dev, Build and the commands picker, joined into one control: what used to
 * be a second row under the bar. Dev shows what its process is doing --
 * stopped, starting, running on its port, or failed -- and stops it on a
 * click while it runs.
 */
export function RunCluster({ project }: { project: Project }) {
  const mac = useIsMac()
  const { dev, build } = useRunState(project)
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

  useRunAnnouncements(dev.state, dev.port, build.state)

  const devText = devLabel(dev.state, dev.port, !dev.command)
  const buildText = build.command
    ? build.state === "running" || build.state === "starting"
      ? "Building… show the terminal"
      : build.state === "error"
        ? "Build failed, build again"
        : "Build"
    : "Add a build command"
  const building = build.state === "running" || build.state === "starting"

  return (
    <div
      role="group"
      aria-label="Run"
      className="border-border light:border-border-strong divide-border light:divide-border-strong flex h-8 shrink-0 items-stretch divide-x overflow-hidden rounded-[9px] border"
    >
      <Hint label={devText}>
        <button
          type="button"
          aria-label={devText}
          onClick={() => dev.toggle() || setMenuOpen(true)}
          className={cn(SEGMENT, "group/dev gap-1.5 px-2.5 text-[13px] font-medium", DEV_LOOK[dev.state])}
        >
          <DevGlyph state={dev.state} />
          <span className="hidden @xl:inline">Dev</span>
          {dev.state === "running" && dev.port && (
            <span className="hidden font-mono text-[11px] @xl:inline">:{dev.port}</span>
          )}
        </button>
      </Hint>

      <Hint label={buildText}>
        <button
          type="button"
          aria-label={buildText}
          onClick={() => build.run() || setMenuOpen(true)}
          className={cn(QUIET_SEGMENT, build.state === "error" && "text-danger hover:text-danger")}
        >
          {building ? (
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <HammerIcon className="size-3.5" />
          )}
        </button>
      </Hint>

      <CommandsMenu
        project={project}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={
          <button
            type="button"
            aria-label="Commands"
            title={`Commands  ${shortcut(mac, "P", true)}`}
            aria-keyshortcuts={mac ? "Meta+Shift+P" : "Control+Shift+P"}
            className={cn(QUIET_SEGMENT, "aria-expanded:bg-muted aria-expanded:text-foreground")}
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
        }
      />
    </div>
  )
}

/** The Dev segment's leading mark: play, a spinner, or a dot that turns into stop on hover. */
function DevGlyph({ state }: { state: RunState }) {
  if (state === "starting") return <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
  if (state === "running") {
    return (
      <span className="grid size-3.5 place-items-center">
        <span className="bg-success size-1.5 rounded-full group-hover/dev:hidden group-focus-visible/dev:hidden" />
        <SquareIcon className="hidden size-3 fill-current group-hover/dev:block group-focus-visible/dev:block" />
      </span>
    )
  }
  return <PlayIcon className="size-3.5" />
}

/** Says the moments that matter -- up, failed, built -- to a screen reader, once each. */
function useRunAnnouncements(dev: RunState, port: number | null, build: RunState) {
  const last = React.useRef({ dev, build })
  React.useEffect(() => {
    const before = last.current
    last.current = { dev, build }
    let message: string | null = null
    if (dev !== before.dev) {
      if (dev === "running") message = port ? `Dev server running on port ${port}` : "Dev server running"
      else if (dev === "error") message = "Dev server failed"
      else if (dev === "stopped" && before.dev === "running") message = "Dev server stopped"
    }
    if (build !== before.build) {
      if (build === "error") message = "Build failed"
      else if (build === "stopped" && (before.build === "running" || before.build === "starting")) message = "Build finished"
    }
    if (message) announce(message)
  }, [dev, port, build])
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
