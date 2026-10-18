import { TimelineWorkspace } from "@/components/timeline/timeline-workspace";
import { requireProject } from "@/lib/workspace-route";

/**
 * A project's timeline, at /{ws}/p/{project_hash}/timeline: its tasks as a Gantt
 * chart. The project is looked up the way the notes do it, so an unknown or
 * someone else's hash 404s before any task is asked for.
 */
export default async function Page({ params }: { params: Promise<{ workspaceHash: string; projectHash: string }> }) {
  const { workspaceHash, projectHash } = await params;
  const project = await requireProject(workspaceHash, projectHash, "project");
  return <TimelineWorkspace project={project} />;
}
