"use client";

import { ActivityIcon, BrainIcon, CoinsIcon, HardDriveIcon } from "lucide-react";

import { StatCard } from "@/components/dashboard-stats";
import { ManageTabs } from "@/components/manage-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, formatBytes, formatUsd } from "@/lib/stats-format";
import type { ManageTab } from "@/lib/manage-tabs";
import { useProject } from "@/lib/queries/project";
import type { Project, ProjectStats } from "@/lib/session";

/**
 * A project's manage page: four figures, then tabs for git, activity and
 * the project's preferences.
 *
 * Uptime and context usage are placeholders until something measures them.
 * Their cards say so, so the sample numbers are never read as the
 * project's own.
 */
export function ProjectManage({
  project: seed,
  stats,
  initialTab,
}: {
  project: Project;
  stats: ProjectStats | null;
  initialTab: ManageTab;
}) {
  const project = useProject(seed.hash) ?? seed;
  return (
    <div className="flex flex-1 flex-col gap-6 p-4">
      <ProjectStatCards stats={stats} />
      <ManageTabs project={project} initialTab={initialTab} />
    </div>
  );
}

function ProjectStatCards({ stats }: { stats: ProjectStats | null }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats ? (
        <StatCard
          icon={CoinsIcon}
          label="Token usage"
          value={compactNumber(stats.tokens.total)}
          title={`${stats.tokens.total.toLocaleString("en-US")} tokens across ${stats.turnCount} turns`}
          detail={`${formatUsd(stats.costUsd)} over ${stats.turnCount} ${
            stats.turnCount === 1 ? "turn" : "turns"
          }`}
          footnote={`${compactNumber(stats.tokens.input)} in · ${compactNumber(
            stats.tokens.output,
          )} out · ${compactNumber(stats.tokens.cacheRead)} cached`}
        />
      ) : (
        <Unavailable icon={CoinsIcon} label="Token usage" />
      )}

      {stats ? (
        <StatCard
          icon={HardDriveIcon}
          label="File storage"
          value={formatBytes(stats.storageBytes)}
          title={`${stats.storageBytes.toLocaleString("en-US")} bytes`}
          detail="The project directory on disk"
          footnote="Counts .git and node_modules too."
        />
      ) : (
        <Unavailable icon={HardDriveIcon} label="File storage" />
      )}

      <StatCard
        icon={ActivityIcon}
        label="Uptime"
        value="99.9%"
        detail="Operational · last 30 days"
        footnote="Placeholder: uptime is not tracked yet."
        muted
      />

      <StatCard
        icon={BrainIcon}
        label="Context usage"
        value="42%"
        detail="84k of 200k tokens"
        footnote="Placeholder: per-project context is not measured yet."
        muted
      />
    </div>
  );
}

function Unavailable({ icon, label }: { icon: typeof CoinsIcon; label: string }) {
  return (
    <StatCard
      icon={icon}
      label={label}
      value="—"
      detail="Could not load this figure"
      footnote="It will show on the next visit if the server answers."
      muted
    />
  );
}

/** The page's loading state: bars where the figures and the tabs go. */
export function ProjectManageSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[134px] rounded-lg" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex h-9 items-center gap-4 border-b px-3">
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-48 rounded-lg" />
      </div>
    </div>
  );
}
