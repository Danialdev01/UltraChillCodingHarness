import { notFound } from "next/navigation";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { PROJECT_HASH } from "@/lib/sections";
import { getProjectByHash } from "@/lib/session";

/**
 * A project's activity log, at /{project_hash}/activity. The project is
 * looked up the way the keys page does it, so an unknown or someone else's
 * hash 404s before any history is asked for.
 */
export default async function Page({ params }: { params: Promise<{ projectHash: string }> }) {
  const { projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();
  return <ActivityFeed source={{ kind: "project", project }} />;
}
