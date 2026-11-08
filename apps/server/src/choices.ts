import type { ChoiceOption, ProviderId } from "@ucch/protocol";
import type { ProviderCard } from "./providers.js";

/** What the person picked on a choice card: an option's id, or null for dismiss. */
export interface ChoiceAnswer {
  optionId: string | null;
  model?: string | undefined;
}

/**
 * Choice cards something in this process is waiting on: a subagent whose
 * harness hit its limit holds its parent's tool call open until the person
 * picks how it carries on. In memory, like a permission prompt's wait: the
 * tool call it holds does not survive a restart either.
 */
export class ChoiceWaiters {
  readonly #open = new Map<string, (answer: ChoiceAnswer) => void>();

  /** Resolves with the answer, or with a dismissal when `signal` aborts first. */
  wait(requestId: string, signal: AbortSignal): Promise<ChoiceAnswer> {
    return new Promise((resolve) => {
      const settle = (answer: ChoiceAnswer) => {
        this.#open.delete(requestId);
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => settle({ optionId: null });
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.#open.set(requestId, settle);
    });
  }

  /** Delivers an answer; false when nothing here waits on `requestId`. */
  answer(requestId: string, answer: ChoiceAnswer): boolean {
    const settle = this.#open.get(requestId);
    if (!settle) return false;
    settle(answer);
    return true;
  }
}

/** One harness as a limit card or the router sees it. */
export interface HarnessAvailability {
  provider: ProviderId;
  label: string;
  usable: boolean;
  blocker: string | null;
  /** Runs OpenRouter models, which the card asks the person to pick. */
  custom: boolean;
}

/**
 * The harnesses a subject could run a turn on now, from its provider
 * cards: Claude Code and Codex as their cards say, and "Custom" -- OMP, or
 * the native loop without it -- on the OpenRouter key. The same rules as
 * the composer's `providerBlocker`.
 */
export function harnessAvailability(
  cards: Record<ProviderId, ProviderCard>,
  options: { cliEnabled: boolean; ompEnabled: boolean },
): HarnessAvailability[] {
  const cli = (id: "claude" | "codex"): HarnessAvailability => {
    const card = cards[id];
    const blocker = !options.cliEnabled || !card.enabled
      ? "Disabled on this server"
      : !card.installed
        ? `${card.label} is not installed on the server`
        : !card.authenticated
          ? `Sign in to ${card.label} in Settings`
          : null;
    return { provider: id, label: card.label, usable: blocker === null, blocker, custom: false };
  };
  const keyed = cards.native.authenticated;
  // OMP is a process, so it is off with the other CLIs; the native loop is not.
  const omp = options.ompEnabled && options.cliEnabled;
  const custom: HarnessAvailability = {
    provider: omp ? "omp" : "native",
    label: "Custom (OpenRouter)",
    usable: keyed,
    blocker: keyed ? null : "Add an OpenRouter key in Settings",
    custom: true,
  };
  return [cli("claude"), cli("codex"), custom];
}

/**
 * The options of a limit card: every harness but the one that hit its
 * limit, each with why it cannot be picked when it cannot. The Custom one
 * asks for an OpenRouter model.
 */
export function limitOptions(harnesses: readonly HarnessAvailability[], limited: ProviderId): ChoiceOption[] {
  const same = (a: ProviderId, b: ProviderId) => a === b || (a !== "claude" && a !== "codex" && b !== "claude" && b !== "codex");
  return harnesses
    .filter((harness) => !same(harness.provider, limited))
    .map((harness) => ({
      id: harness.custom ? "custom" : harness.provider,
      label: harness.custom ? "Continue on an OpenRouter model" : `Continue on ${harness.label}`,
      provider: harness.provider,
      ...(harness.custom ? { pickModel: true, detail: "Billed to the OpenRouter key" } : {}),
      ...(harness.blocker ? { blocker: harness.blocker } : {}),
    }));
}

/** "Claude Code", "Codex", "Custom": a provider as the cards name it. */
export function harnessLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "Custom";
}
