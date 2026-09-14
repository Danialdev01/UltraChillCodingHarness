import { FULL_RATIO, WARN_RATIO, type ContextTone } from "./context-window.js";

/**
 * The rail's three meters: what each harness has left of its allowance.
 *
 * Mirrors the server's `SessionQuota`. The numbers are the vendors' own --
 * a subscription's rolling windows as a percent, a key's spend against its
 * cap -- flattened to what one bar can draw. This decides how to say it.
 */

export type QuotaProvider = "native" | "claude" | "codex";

export interface QuotaWindow {
  id: "session" | "weekly" | "spend";
  label: string;
  /** 0-100. */
  usedPercent: number;
  resetsAt: string | null;
  detail?: string;
}

export type SessionQuota =
  | { provider: QuotaProvider; status: "ok"; windows: QuotaWindow[]; checkedAt: string }
  | { provider: QuotaProvider; status: "no_auth" }
  | { provider: QuotaProvider; status: "unavailable"; error?: string };

export type SessionQuotas = Record<QuotaProvider, SessionQuota>;

/** The order the rail draws them in, top to bottom, with the two-letter tag each bar wears. */
export const QUOTA_PROVIDERS: ReadonlyArray<{ id: QuotaProvider; label: string; tag: string }> = [
  { id: "claude", label: "Claude Code", tag: "CC" },
  { id: "codex", label: "Codex", tag: "CX" },
  { id: "native", label: "OpenRouter", tag: "OR" },
];

/**
 * The window the bar draws.
 *
 * The session window where there is one: it is the limit anyone about to
 * start a turn runs into first, and the weekly figure is a line in the
 * tooltip rather than a second bar. OpenRouter has only spend.
 */
export function primaryWindow(quota: SessionQuota): QuotaWindow | null {
  if (quota.status !== "ok") return null;
  return quota.windows.find((w) => w.id === "session") ?? quota.windows[0] ?? null;
}

/** Same thresholds as the context meter, so the two bars agree on what "nearly out" means. */
export function quotaTone(usedPercent: number | null): ContextTone {
  if (usedPercent === null) return "idle";
  const ratio = usedPercent / 100;
  if (ratio >= FULL_RATIO) return "full";
  if (ratio >= WARN_RATIO) return "warn";
  return "normal";
}

/**
 * "in 2h 15m", "in 3d", or "" when the vendor did not say.
 *
 * Coarse on purpose: a reset time is read to decide whether to wait or to
 * switch harness, and minutes past the hour do not change that answer.
 */
export function formatResetsIn(resetsAt: string | null, now = Date.now()): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes === 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `resets in ${days}d ${restHours}h` : `resets in ${days}d`;
}

/** Whole percent for a readout; a bar at 47.3% reads "47%". */
export function formatPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}
