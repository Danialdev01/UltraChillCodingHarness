import { notFound } from "next/navigation";

import { ProjectManage } from "@/components/project-manage";
import { manageTabOf } from "@/lib/manage-tabs";
import { PROJECT_HASH } from "@/lib/sections";
import { getProjectStats } from "@/lib/session";
import { requireProject } from "@/lib/workspace-route";

/**
 * A project's manage page, at /{ws}/p/{project_hash}/manage. An unknown or someone
 * else's hash 404s. `?tab=` picks the tab it opens on.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceHash: string; projectHash: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ workspaceHash, projectHash }, { tab }] = await Promise.all([params, searchParams]);
  if (!PROJECT_HASH.test(projectHash)) notFound();
  // Together: the stats route checks ownership itself, so asking for the
  // figures of an unknown hash costs nothing but a 404 that is discarded.
  const [project, stats] = await Promise.all([
    requireProject(workspaceHash, projectHash, "project"),
    getProjectStats(projectHash),
  ]);
  return <ProjectManage project={project} stats={stats} initialTab={manageTabOf(tab)} />;
}
