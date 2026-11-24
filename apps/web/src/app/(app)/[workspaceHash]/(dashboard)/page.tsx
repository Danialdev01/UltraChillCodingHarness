import { Suspense } from "react";

import { DashboardStats, QuotaCard } from "@/components/dashboard-stats";
import { StatCardSkeleton } from "@/components/page-skeletons";
import { ProjectsTable } from "@/components/projects-table";
import {
  getOpenRouterQuota,
  getWorkspaceStats,
  listProjects,
} from "@/lib/session";
import { requireWorkspace } from "@/lib/workspace-route";

/**
 * A workspace's own address, `/{ws}`: the workspace at a glance: the four numbers, then the projects behind them.
 *
 * The stats and the projects are fetched together rather than in sequence --
 * neither depends on the other, and the page is as slow as the slower of the
 * two either way.
 */
export default async function DashboardPage({ params }: { params: Promise<{ workspaceHash: string }> }) {
  const { workspaceHash } = await params;
  // Also where an old `/{projectHash}` bookmark lands, and is sent on from.
  const active = await requireWorkspace(workspaceHash);

  const [stats, projects] = await Promise.all([
    getWorkspaceStats(active.id),
    listProjects(active.id),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <DashboardStats
        stats={stats}
        quotaCard={
          <Suspense fallback={<StatCardSkeleton />}>
            <OpenRouterQuotaCard />
          </Suspense>
        }
      />
      <ProjectsTable projects={projects} />
    </div>
  );
}

/**
 * The quota is the account's, and asked of OpenRouter itself, which can take
 * seconds: streamed on its own so the dashboard never waits for it.
 */
async function OpenRouterQuotaCard() {
  return <QuotaCard quota={await getOpenRouterQuota()} />;
}
