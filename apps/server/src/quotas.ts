import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "@ucch/protocol";
import type { KeyQuota } from "./openrouter.js";

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
 * Read from the vendors directly rather than scraped from a running turn:
 * a meter that only moved while an agent was busy would be stale exactly
 * when someone looked at it to decide whether to start one.
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

// -- Claude ------------------------------------------------------------------

/**
 * The Claude Code credential file, as the CLI writes it under its config
 * directory. Only the one field that is read.
 */
interface ClaudeCredentials {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

/** The OAuth token Claude Code signed in with, or null when it has not. */
export async function readClaudeAccessToken(claudeDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(claudeDir, ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as ClaudeCredentials;
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * What `api.anthropic.com/api/oauth/usage` answers. Only the two windows
 * every subscription has; the per-model and promotional buckets vary by
 * plan and are left out rather than drawn as bars nobody asked for.
 */
interface ClaudeUsageBody {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
}

export function parseClaudeUsage(body: unknown): QuotaWindow[] {
  const usage = (body ?? {}) as ClaudeUsageBody;
  const windows: QuotaWindow[] = [];
  const session = clampPercent(usage.five_hour?.utilization);
  if (session !== null) {
    windows.push({
      id: "session",
      label: "Session (5h)",
      usedPercent: session,
      resetsAt: isoOrNull(usage.five_hour?.resets_at),
    });
  }
  const weekly = clampPercent(usage.seven_day?.utilization);
  if (weekly !== null) {
    windows.push({
      id: "weekly",
      label: "Weekly",
      usedPercent: weekly,
      resetsAt: isoOrNull(usage.seven_day?.resets_at),
    });
  }
  return windows;
}

export async function fetchClaudeUsage(token: string, signal?: AbortSignal): Promise<QuotaWindow[]> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      // The usage endpoint is OAuth-only and sits behind this beta flag,
      // the same one the CLI sends.
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    },
    signal,
  });
  // The CLI renews its own token the next time it runs; the harness does
  // not write credential files, so until then the honest word is "expired".
  if (response.status === 401) throw new Error("the sign-in has expired; it renews on the next Claude Code turn");
  if (response.status === 429) throw new Error("Anthropic is rate-limiting the lookup; it retries in a minute");
  if (!response.ok) throw new Error(`claude usage failed: ${response.status}`);
  return parseClaudeUsage(await response.json());
}

// -- Codex -------------------------------------------------------------------

/** `auth.json` as the Codex CLI writes it with the file credential store. */
interface CodexAuth {
  tokens?: { access_token?: string; account_id?: string };
}

export interface CodexTokens {
  accessToken: string;
  accountId: string | null;
}

export async function readCodexTokens(codexDir: string): Promise<CodexTokens | null> {
  try {
    const raw = await readFile(join(codexDir, "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as CodexAuth;
    const token = parsed.tokens?.access_token;
    if (typeof token !== "string" || !token) return null;
    const accountId = parsed.tokens?.account_id;
    return { accessToken: token, accountId: typeof accountId === "string" ? accountId : null };
  } catch {
    return null;
  }
}

/**
 * What `chatgpt.com/backend-api/wham/usage` answers. Codex names its two
 * windows by position rather than by length, and says how long each is.
 */
interface CodexUsageBody {
  rate_limit?: {
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number | string;
}

function codexWindow(window: CodexWindow | null | undefined, now: number): QuotaWindow | null {
  const used = clampPercent(window?.used_percent);
  if (used === null) return null;
  const seconds = window?.limit_window_seconds ?? 0;
  const hours = Math.round(seconds / 3600);
  // A day or longer is the weekly bucket; anything shorter is the session.
  const weekly = seconds >= 24 * 3600;
  let resetsAt: string | null = null;
  if (typeof window?.reset_after_seconds === "number") {
    resetsAt = new Date(now + window.reset_after_seconds * 1000).toISOString();
  } else if (typeof window?.reset_at === "number") {
    resetsAt = new Date(window.reset_at * 1000).toISOString();
  } else {
    resetsAt = isoOrNull(window?.reset_at);
  }
  return {
    id: weekly ? "weekly" : "session",
    label: weekly ? "Weekly" : hours > 0 ? `Session (${hours}h)` : "Session",
    usedPercent: used,
    resetsAt,
  };
}

export function parseCodexUsage(body: unknown, now = Date.now()): QuotaWindow[] {
  const usage = (body ?? {}) as CodexUsageBody;
  const windows: QuotaWindow[] = [];
  const primary = codexWindow(usage.rate_limit?.primary_window, now);
  if (primary) windows.push(primary);
  const secondary = codexWindow(usage.rate_limit?.secondary_window, now);
  // Two windows of the same length would draw the same bar twice.
  if (secondary && secondary.id !== primary?.id) windows.push(secondary);
  return windows;
}

export async function fetchCodexUsage(tokens: CodexTokens, signal?: AbortSignal): Promise<QuotaWindow[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens.accessToken}`,
    accept: "application/json",
  };
  if (tokens.accountId) headers["chatgpt-account-id"] = tokens.accountId;
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal });
  if (response.status === 401) throw new Error("the sign-in has expired; it renews on the next Codex turn");
  if (response.status === 429) throw new Error("OpenAI is rate-limiting the lookup; it retries in a minute");
  if (!response.ok) throw new Error(`codex usage failed: ${response.status}`);
  return parseCodexUsage(await response.json());
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
