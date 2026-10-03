import { notFound } from "next/navigation";

import { TimelineWorkspace } from "@/components/timeline/timeline-workspace";
import { PROJECT_HASH } from "@/lib/sections";
import { getProjectByHash } from "@/lib/session";

/**
 * A project's timeline, at /{project_hash}/timeline: its tasks as a Gantt
 * chart. The project is looked up the way the notes do it, so an unknown or
 * someone else's hash 404s before any task is asked for.
 */
export default async function Page({ params }: { params: Promise<{ projectHash: string }> }) {
  const { projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();
  return <TimelineWorkspace project={project} />;
}
