import {
  CoinsIcon,
  ListTodoIcon,
  MonitorPlayIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";

import { compactNumber, describeQuota, formatUsd } from "@/lib/stats-format";
import type { QuotaResult, WorkspaceStats } from "@/lib/session";
import { TransitionLink } from "@/lib/view-transitions";

/**
 * The four numbers the Dashboard opens with.
 *
 * Each card is one figure with one line under it saying what it is made of --
 * a card that shows a number without saying what would change it is
 * decoration. Where there is no data yet the card says so rather than
 * showing a zero, because "nothing due" and "this does not exist yet" are
 * different facts and only one of them is true here.
 */
export function DashboardStats({
  stats,
  quota,
}: {
  stats: WorkspaceStats | null;
  /** The account's OpenRouter standing. Its own fetch, so its own failure. */
  quota: QuotaResult;
}) {
  if (!stats) {
    return (
      <div className="rounded-lg border p-6">
        <p className="text-muted-foreground text-sm">
          Could not load this workspace&apos;s statistics.
        </p>
      </div>
    );
  }

  const { tokens, previews } = stats;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={CoinsIcon}
        label="Token usage"
        value={compactNumber(tokens.total)}
        title={`${tokens.total.toLocaleString("en-US")} tokens across ${stats.turnCount} turns`}
        detail={`${formatUsd(stats.costUsd)} over ${stats.turnCount} ${
          stats.turnCount === 1 ? "turn" : "turns"
        }`}
        // Cache reads are the majority of a long thread's tokens and are
        // billed at a fraction of the rate, so a total without the split
        // reads alarmingly larger than the bill it produced.
        footnote={`${compactNumber(tokens.input)} in · ${compactNumber(
          tokens.output,
        )} out · ${compactNumber(tokens.cacheRead)} cached`}
      />

      {/* What is left to spend, beside what has been spent: the two cards
          answer the question the first one raises. The account's, not the
          workspace's -- one key pays for every workspace. */}
      {quota.status === "ok" ? (
        <StatCard icon={WalletIcon} label="OpenRouter quota" {...describeQuota(quota.quota)} />
      ) : (
        <StatCard
          icon={WalletIcon}
          label="OpenRouter quota"
          value="—"
          detail={
            quota.status === "no_key" ? "No OpenRouter key on this account" : "Could not reach OpenRouter"
          }
          footnote={
            quota.status === "no_key" ? (
              <TransitionLink
                href="/setting#api"
                className="text-ucch-active underline underline-offset-2"
              >
                Add one in Settings
              </TransitionLink>
            ) : (
              "The balance will show once it answers again."
            )
          }
          muted
        />
      )}

      <StatCard
        icon={ListTodoIcon}
        label="Todo due"
        value="—"
        detail="Arrives with the agent core"
        footnote="Nothing records tasks yet, so there is nothing to count."
        muted
      />

      <StatCard
        icon={MonitorPlayIcon}
        label="Monitor preview"
        value={String(previews.live)}
        detail={
          previews.total === 0
            ? "No previews published yet"
            : `${previews.live} live of ${previews.total} published`
        }
        footnote={
          previews.expiringSoon > 0
            ? `${previews.expiringSoon} expiring within 24h`
            : "None expiring in the next 24h"
        }
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  footnote,
  title,
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  footnote: React.ReactNode;
  /** The exact figure, for the reader who wants it. */
  title?: string;
  /** Dims the number where there is no data behind it. */
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Icon className="size-4" />
        {label}
      </div>
      <p
        title={title}
        className={`mt-2 text-3xl font-semibold tabular-nums ${
          muted ? "text-muted-foreground" : ""
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-sm">{detail}</p>
      <p className="text-muted-foreground mt-auto pt-2 text-xs">{footnote}</p>
    </div>
  );
}
