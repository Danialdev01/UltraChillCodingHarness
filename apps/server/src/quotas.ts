import type { ProviderId } from "@ucch/protocol";
import type { ProviderRateLimits } from "@ucch/providers";
import type { KeyQuota } from "./openrouter.js";
import { profileKey, type ProfileRef } from "./profile-ref.js";

/**
 * How much of each harness's allowance has been used, for the sidebar's
 * meters.
 *
 * Three providers, three very different ideas of a limit: Claude and Codex
 * subscriptions meter a rolling session window and a weekly one, each as a
 * percentage; an OpenRouter key spends money against a cap or a balance.
 * They are flattened to the one shape a progress bar can draw -- a percent
 * used and when it resets -- so the rail shows three bars that read alike,
 * and the tooltip carries whatever the vendor's own words were.
 *
 * Claude Code and Codex readings come from the CLIs themselves, never from
 * the vendors with the login's token (the harness does not read, copy or
 * use what a CLI's sign-in wrote): Codex answers `account/rateLimits/read`
 * on its own app server whenever asked; Claude Code reports its usage only
 * inside a turn (`rate_limit_event`), so its meter is the last turn's
 * reading, and says how old it is.
 */

export interface QuotaWindow {
  /** `session` is the short rolling window; `weekly` the long one; `spend` money. */
  id: "session" | "weekly" | "spend";
  label: string;
  /** 0-100, clamped. What the bar draws. */
  usedPercent: number;
  /** ISO time the window rolls over, when the vendor says. */
  resetsAt: string | null;
  /** A vendor-specific line the tooltip can show under the percent. */
  detail?: string;
  model?: "opus" | "sonnet";
}

/**
 * One provider's standing, or why there is none to show.
 *
 * Three states rather than an empty list: "not signed in" and "could not
 * ask" want different words in the tooltip, and collapsing them would tell
 * the person to sign in to an account they are signed in to.
 */
export type SessionQuota =
  | { provider: ProviderId; status: "ok"; windows: QuotaWindow[]; checkedAt: string }
  | { provider: ProviderId; status: "no_auth" }
  | { provider: ProviderId; status: "unavailable"; error?: string };

export type SessionQuotas = Record<ProviderId, SessionQuota>;

function clampPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

// -- OpenRouter --------------------------------------------------------------

/**
 * A key's spend as one bar.
 *
 * The tighter of the two figures OpenRouter keeps: the key's own cap when
 * it has one, else the account's credit balance. A key with neither is
 * unlimited as far as OpenRouter is concerned, and an unlimited bar is an
 * empty one that says so.
 */
export function openRouterWindows(quota: KeyQuota): QuotaWindow[] {
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (quota.limitUsd !== null && quota.limitUsd > 0) {
    const used = Math.min(quota.usageUsd, quota.limitUsd);
    return [
      {
        id: "spend",
        label: "Key limit",
        usedPercent: clampPercent((used / quota.limitUsd) * 100) ?? 0,
        resetsAt: null,
        detail: `${money(used)} of ${money(quota.limitUsd)}`,
      },
    ];
  }
  if (quota.credits && quota.credits.totalUsd > 0) {
    const used = Math.min(quota.credits.usedUsd, quota.credits.totalUsd);
    return [
      {
        id: "spend",
        label: "Credits",
        usedPercent: clampPercent((used / quota.credits.totalUsd) * 100) ?? 0,
        resetsAt: null,
        detail: `${money(used)} of ${money(quota.credits.totalUsd)}`,
      },
    ];
  }
  return [
    {
      id: "spend",
      label: "Spend",
      usedPercent: 0,
      resetsAt: null,
      detail: `${money(quota.usageUsd)} spent; no limit on this key`,
    },
  ];
}

const WINDOW_LABEL = { session: "Session (5h)", weekly: "Weekly" } as const;

/** A CLI's reading as the meters' windows. */
export function cliWindows(windows: ProviderRateLimits["windows"]): QuotaWindow[] {
  return windows.map((w) => ({
    id: w.id,
    label: w.id === "session" && w.minutes && w.minutes !== 300 ? `Session (${Math.round(w.minutes / 60)}h)` : WINDOW_LABEL[w.id],
    usedPercent: clampPercent(w.usedPercent) ?? 0,
    resetsAt: isoOrNull(w.resetsAt),
  }));
}

/** What the quota service asks of the providers. */
export interface QuotaSource {
  /** Codex's own answer; throws when it cannot give one. */
  rateLimits(subject: string, provider: "codex", profile?: ProfileRef | null): Promise<ProviderRateLimits>;
  /** Whether the subject's CLI is signed in, by its own status check. */
  signedIn(subject: string, provider: "claude" | "codex", profile?: ProfileRef | null): Promise<boolean>;
}

/** How long a Codex answer is reused: the meters poll. */
const CODEX_TTL_MS = 60_000;

/**
 * Subscription usage per credential subject (a user, or `ws-<id>`) and
 * account (`profileKey`: the subject itself for its Default account).
 * Claude's is whatever the subject's last turn reported (`record`); Codex's
 * is asked of the CLI and reused for a minute.
 */
export class SubscriptionQuotaService {
  private readonly claude = new Map<string, { at: number; windows: QuotaWindow[] }>();
  private readonly cache = new Map<string, { at: number; value: SessionQuota }>();
  private readonly pending = new Map<string, Promise<SessionQuota>>();
  constructor(private readonly source: QuotaSource) {}

  /** A turn's `agent.rate_limit`: the subject's latest Claude reading. */
  record(subject: string, windows: ProviderRateLimits["windows"], profile?: ProfileRef | null): void {
    if (windows.length === 0) return;
    this.claude.set(profileKey(subject, "claude", profile), { at: Date.now(), windows: cliWindows(windows) });
  }

  async get(subject: string, provider: "claude" | "codex", profile?: ProfileRef | null): Promise<SessionQuota> {
    const key = profileKey(subject, provider, profile);
    if (provider === "claude") {
      const reading = this.claude.get(key);
      if (reading) return { provider, status: "ok", windows: reading.windows, checkedAt: new Date(reading.at).toISOString() };
      if (!(await this.source.signedIn(subject, provider, profile).catch(() => true))) return { provider, status: "no_auth" };
      return { provider, status: "unavailable", error: "Claude Code reports its usage during a turn; the meter fills after the next one." };
    }
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CODEX_TTL_MS) return hit.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const lookup = this.lookupCodex(subject, profile).then((value) => {
      this.cache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, lookup);
    return lookup;
  }

  /**
   * Forgets readings after a sign-in or sign-out: one account's, by its
   * `profileKey`, or a subject's and every account of it.
   */
  forget(key: string): void {
    for (const map of [this.claude, this.cache]) {
      for (const k of map.keys()) if (k === key || (!key.includes("/") && k.startsWith(`${key}/`))) map.delete(k);
    }
  }

  private async lookupCodex(subject: string, profile?: ProfileRef | null): Promise<SessionQuota> {
    const provider = "codex" as const;
    if (!(await this.source.signedIn(subject, provider, profile).catch(() => true))) return { provider, status: "no_auth" };
    try {
      const { windows } = await this.source.rateLimits(subject, provider, profile);
      return { provider, status: "ok", windows: cliWindows(windows), checkedAt: new Date().toISOString() };
    } catch (error) {
      return { provider, status: "unavailable", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
