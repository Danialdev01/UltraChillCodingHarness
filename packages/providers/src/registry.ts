import type { CliProviderId, ProviderId } from "@ucch/protocol";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import type { AgentProvider } from "./types.js";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  native: "Custom",
  claude: "Claude Code",
  codex: "Codex",
};

export function isCliProviderId(value: unknown): value is CliProviderId {
  return value === "claude" || value === "codex";
}

export function createProviders(options: {
  claudeBin: string;
  codexBin: string;
  isRepo?: (cwd: string) => boolean;
}): Record<CliProviderId, AgentProvider> {
  return {
    claude: new ClaudeProvider(options.claudeBin),
    codex: new CodexProvider(options.codexBin, options.isRepo),
  };
}
