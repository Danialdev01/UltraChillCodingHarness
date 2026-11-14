import type { ComponentType } from "react"

import { ClaudeMark } from "@/components/icons/harness/claude"
import { CodexMark } from "@/components/icons/harness/codex"
import type { HarnessIconProps } from "@/components/icons/harness/types"
import { OmpMark } from "@/components/icons/harness/omp"
import { UnknownMark } from "@/components/icons/harness/unknown"

/**
 * The AI harnesses a session can run on, keyed by the provider id the
 * server binds a thread to (`threads.provider`): the one source for each
 * harness's name, mark and how its models read.
 *
 * `native` (the built-in OpenRouter loop) and `omp` are both UCCH's own
 * agent to the person using it -- the picker calls either "Default", with
 * OMP's mark, since OMP serves it -- so they share a harness. A new one (Gemini CLI, OpenCode) is a row here and a mark
 * in `components/icons/harness/`.
 */
export type HarnessId = "claude" | "codex" | "ucch"

export interface HarnessDef {
  /** `unknown` for the fallback. */
  id: HarnessId | "unknown"
  name: string
  icon: ComponentType<HarnessIconProps>
  /** How a model id of this harness reads in a sidebar, e.g. "Opus 5.5". */
  modelLabel: (model: string) => string
}

/** The provider ids each harness serves threads for. */
const PROVIDERS: Record<string, HarnessId> = {
  claude: "claude",
  codex: "codex",
  native: "ucch",
  omp: "ucch",
}

const lastSegment = (model: string) => model.split("/").pop() ?? model

/**
 * `claude-opus-5-5` -> "Opus 5.5", `claude-sonnet-4-5-20250929` -> "Sonnet
 * 4.5", the CLI's own aliases (`opus`, `sonnet[1m]`) -> "Opus", "Sonnet".
 */
export function claudeModelLabel(model: string): string {
  const id = lastSegment(model).replace(/\[[^\]]*\]$/, "")
  const match = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d{1,2}))?)?(?:-\d{8})?$/i.exec(id)
  if (!match) return id
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  if (!match[2]) return family
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`
}

/** `gpt-5-codex` -> "GPT-5 Codex", `gpt-5.1-codex-mini` -> "GPT-5.1 Codex Mini", `o3` -> "o3". */
export function codexModelLabel(model: string): string {
  const id = lastSegment(model)
  const match = /^gpt-([\d.]+)(.*)$/i.exec(id)
  if (!match) return id
  const rest = match[2]!
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
  return `GPT-${match[1]}${rest ? ` ${rest}` : ""}`
}

export const HARNESSES: Record<HarnessId, HarnessDef> = {
  claude: { id: "claude", name: "Claude Code", icon: ClaudeMark, modelLabel: claudeModelLabel },
  codex: { id: "codex", name: "Codex", icon: CodexMark, modelLabel: codexModelLabel },
  ucch: {
    id: "ucch",
    name: "Default",
    icon: OmpMark,
    modelLabel: (model) => `Default · ${lastSegment(model)}`,
  },
}

export const UNKNOWN_HARNESS: HarnessDef = {
  id: "unknown",
  name: "Agent",
  icon: UnknownMark,
  modelLabel: lastSegment,
}

/** The harness id a provider id belongs to, or null for one this build does not know. */
export function harnessIdOf(provider: string | null | undefined): HarnessId | null {
  return provider && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider]! : null
}

/** The harness for a provider id (or a harness id); the generic one for anything else. */
export function getHarness(id: string | null | undefined): HarnessDef {
  if (!id) return UNKNOWN_HARNESS
  const harness = harnessIdOf(id) ?? (Object.hasOwn(HARNESSES, id) ? (id as HarnessId) : null)
  return harness ? HARNESSES[harness] : UNKNOWN_HARNESS
}

/**
 * The model a session last ran on, as its tooltip shows it: the harness's
 * own reading of the id, or the catalogue's name when `names` has it. A
 * session without a turn yet reads as its harness.
 */
export function sessionModelLabel(
  provider: string | null | undefined,
  model: string | null | undefined,
  names?: ReadonlyMap<string, string>,
): string {
  const harness = getHarness(provider)
  if (!model) return harness.name
  const named = names?.get(model)
  if (named) return harness.id === "ucch" ? `Default · ${named}` : named
  return harness.modelLabel(model)
}
