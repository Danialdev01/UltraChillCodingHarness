import { cookies } from "next/headers";

import { DashboardStats } from "@/components/dashboard-stats";
import { ProjectsTable } from "@/components/projects-table";
import {
  getOpenRouterQuota,
  getWorkspaceStats,
  listProjects,
  listWorkspaces,
} from "@/lib/session";

/**
 * The workspace at a glance: the four numbers, then the projects behind them.
 *
 * The stats and the projects are fetched together rather than in sequence --
 * neither depends on the other, and the page is as slow as the slower of the
 * two either way.
 */
export default async function DashboardPage() {
  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get("ucch_workspace")?.value;
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0];

  // The quota is the account's, not the workspace's: one key pays for all
  // of them, so it is fetched alongside rather than through the workspace.
  const [stats, projects, quota] = await Promise.all([
    getWorkspaceStats(active?.id ?? ""),
    listProjects(active?.id ?? ""),
    getOpenRouterQuota(),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <DashboardStats stats={stats} quota={quota} />
      <ProjectsTable projects={projects} />
    </div>
  );
}
