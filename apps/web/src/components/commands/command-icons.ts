import {
  BugIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  HammerIcon,
  PackageIcon,
  PlayIcon,
  RefreshCwIcon,
  RocketIcon,
  SparklesIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react"
import type { ProjectCommandIcon } from "@ucch/protocol"

/** What each icon name in `.agent/commands.json` draws. */
export const COMMAND_ICONS: Record<ProjectCommandIcon, LucideIcon> = {
  terminal: SquareTerminalIcon,
  play: PlayIcon,
  hammer: HammerIcon,
  flask: FlaskConicalIcon,
  rocket: RocketIcon,
  database: DatabaseIcon,
  refresh: RefreshCwIcon,
  package: PackageIcon,
  bug: BugIcon,
  sparkles: SparklesIcon,
}

export function commandIcon(name: string | undefined): LucideIcon {
  return (name && COMMAND_ICONS[name as ProjectCommandIcon]) || SquareTerminalIcon
}
