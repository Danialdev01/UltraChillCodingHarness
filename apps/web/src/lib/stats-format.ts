/**
 * How numbers and times are written on the Dashboard and the project tables.
 *
 * Pulled out of the components because these are the parts with edges -- a
 * count that crosses a thousand, a timestamp on the boundary of "yesterday",
 * a cost too small to show in cents -- and a component is an awkward place to
 * test an edge.
 */

/**
 * A large count, shortened the way a person would say it: 12.4k, 3.1M.
 *
 * Token totals run to seven and eight digits, and a dashboard card is read at
 * a glance rather than audited -- the exact figure belongs in a tooltip,
 * which is where `toLocaleString` output goes instead.
 */
export function compactNumber(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  for (const [limit, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (n >= limit) {
      const scaled = n / limit;
      // One decimal only while it adds something: 1.2M says more than 1M,
      // 340M does not become clearer as 340.0M.
      return `${scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, "") : Math.round(scaled)}${suffix}`;
    }
  }
  return String(n);
}

/**
 * Money, at the precision it is actually worth reading.
 *
 * A turn can cost a fraction of a cent, and rounding that to $0.00 tells the
 * reader their usage is free. Sub-cent totals keep enough digits to be a
 * number rather than a zero.
 */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * How long ago something happened, in the coarsest unit that is still true.
 *
 * `now` is a parameter rather than a call to `Date.now()` so this is
 * deterministic under test, and so a table can stamp every row against one
 * instant instead of drifting between the first row and the last.
 */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";

  const seconds = Math.round((now - then) / 1000);
  // A clock a little ahead of the server is ordinary; "in 4 seconds" as a
  // last-active time is not.
  if (seconds < 60) return "just now";

  for (const [unit, size] of [
    ["y", 31536000],
    ["mo", 2592000],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

/**
 * A container or preview state as a word and a colour role.
 *
 * The colour is a token name rather than a class so the caller decides
 * whether it lands on a dot, a border or text -- and so every one of them
 * resolves through the theme rather than a hardcoded green.
 */
export function describeContainerState(state: string): {
  label: string;
  tone: "live" | "busy" | "idle" | "failed";
} {
  switch (state) {
    case "running":
      return { label: "Running", tone: "live" };
    case "starting":
    case "building":
    case "cloning":
      return { label: state[0]!.toUpperCase() + state.slice(1), tone: "busy" };
    case "error":
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "stopped":
      return { label: "Stopped", tone: "idle" };
    case "absent":
      return { label: "Not built", tone: "idle" };
    default:
      return { label: state || "Unknown", tone: "idle" };
  }
}

/** `owner/repo` out of a clone URL -- the part of it anyone reads. */
export function shortRepo(url: string | null | undefined): string {
  // Null is a project that was started rather than cloned, and the dash is
  // the honest answer: there is no repository to name yet.
  if (!url) return "—";
  const trimmed = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  if (parts.length < 2) return trimmed;
  return parts.slice(-2).join("/");
}

/** The quota card's four lines, from what OpenRouter reported. */
export interface QuotaCard {
  value: string;
  detail: string;
  footnote: string;
  /** The exact figures, for the reader who hovers. */
  title: string;
}

/**
 * What the quota card says, decided once here rather than in JSX.
 *
 * OpenRouter reports two ceilings that can each run out: the key's own
 * spending limit, and the account's credit balance. The headline is the
 * tighter of the two, because that is the one that stops the next turn,
 * and the detail names which it is so the person knows where to top up. A
 * key with no limit on an account whose balance cannot be read has no
 * ceiling to report, and the card then shows what was spent instead --
 * labelled as spend, not as a balance, so nobody reads a bill as a budget.
 */
export function describeQuota(quota: {
  label: string | null;
  usageUsd: number;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  freeTier: boolean;
  credits: { totalUsd: number; usedUsd: number } | null;
}): QuotaCard {
  const balance = quota.credits ? quota.credits.totalUsd - quota.credits.usedUsd : null;
  const keyLeft = quota.limitRemainingUsd;

  const who = quota.label ? `Key “${quota.label}”` : "This key";
  const tier = quota.freeTier ? " · free tier" : "";
  const title = [
    `${formatUsd(quota.usageUsd)} spent through this key`,
    quota.limitUsd !== null ? `key limit ${formatUsd(quota.limitUsd)}` : "no key limit",
    quota.credits
      ? `account credits ${formatUsd(quota.credits.totalUsd)}, used ${formatUsd(quota.credits.usedUsd)}`
      : "account balance not readable with this key",
  ].join(" · ");

  // Both ceilings known: the lower one is the headline, the other the footnote.
  if (keyLeft !== null && balance !== null) {
    const keyIsTighter = keyLeft <= balance;
    return {
      value: formatUsd(Math.max(0, keyIsTighter ? keyLeft : balance)),
      detail: keyIsTighter
        ? `left of the ${formatUsd(quota.limitUsd ?? 0)} key limit`
        : `credit balance · ${formatUsd(quota.credits!.usedUsd)} used`,
      footnote: keyIsTighter
        ? `${formatUsd(Math.max(0, balance))} account balance${tier}`
        : `${formatUsd(Math.max(0, keyLeft))} left on the key limit${tier}`,
      title,
    };
  }

  if (keyLeft !== null) {
    return {
      value: formatUsd(Math.max(0, keyLeft)),
      detail: `left of the ${formatUsd(quota.limitUsd ?? 0)} key limit`,
      footnote: `${formatUsd(quota.usageUsd)} spent through ${who.toLowerCase()}${tier}`,
      title,
    };
  }

  if (balance !== null) {
    return {
      value: formatUsd(Math.max(0, balance)),
      detail: `credit balance · ${formatUsd(quota.credits!.usedUsd)} used`,
      footnote: `${who} has no spending limit of its own${tier}`,
      title,
    };
  }

  return {
    value: formatUsd(quota.usageUsd),
    detail: "spent through this key · no limit set",
    footnote: `${who}${tier} · balance not readable`,
    title,
  };
}
