import { TasksBoard } from "@/components/tasks/tasks-board";
import { listProjects } from "@/lib/session";
import { requireProject } from "@/lib/workspace-route";

/**
 * A project's Tasks board, at /{ws}/p/{project_hash}/tasks: todos the AI carries
 * from Idea through Research, Ongoing and Verification to Done.
 */
export default async function Page({ params }: { params: Promise<{ workspaceHash: string; projectHash: string }> }) {
  const { workspaceHash, projectHash } = await params;
  const project = await requireProject(workspaceHash, projectHash, "project");
  // The new-todo dialog offers every project of the workspace, this one first picked.
  const listed = project.workspaceId ? await listProjects(project.workspaceId) : [];
  const projects = listed.some((p) => p.hash === project.hash) ? listed : [project, ...listed];
  return <TasksBoard project={project} projects={projects} />;
}
