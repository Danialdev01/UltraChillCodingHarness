import type { CliProviderId, ProviderId } from "@ucch/protocol";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { OmpProvider } from "./omp.js";
import type { AgentProvider } from "./types.js";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  native: "Default",
  claude: "Claude Code",
  codex: "Codex",
  omp: "Default",
};

export function isCliProviderId(value: unknown): value is CliProviderId {
  return value === "claude" || value === "codex" || value === "omp";
}

/**
 * The provider objects the server runs turns through. `omp` is optional
 * until its provider exists (OMP plan, OM2): where it is missing, an `omp`
 * thread finds no provider and its turn fails the way an unknown one does.
 */
export interface CliProviders {
  claude: AgentProvider;
  codex: AgentProvider;
  omp?: AgentProvider;
}

export function createProviders(options: {
  claudeBin: string;
  codexBin: string;
  /** OMP's binary; absent, there is no OMP provider. */
  ompBin?: string;
  isRepo?: (cwd: string) => boolean;
}): CliProviders {
  return {
    claude: new ClaudeProvider(options.claudeBin),
    codex: new CodexProvider(options.codexBin, options.isRepo),
    ...(options.ompBin ? { omp: new OmpProvider(options.ompBin) } : {}),
  };
}
