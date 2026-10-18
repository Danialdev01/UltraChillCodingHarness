import { ProjectsTable } from "@/components/projects-table";
import { listProjects } from "@/lib/session";
import { requireWorkspace } from "@/lib/workspace-route";

/**
 * Code: every project in the workspace, as a table.
 *
 * The section blurb that used to stand here said what the page was for to a
 * reader who was already looking at it. The projects say it better.
 */
export default async function CodePage({ params }: { params: Promise<{ workspaceHash: string }> }) {
  const { workspaceHash } = await params;
  const active = await requireWorkspace(workspaceHash);
  const projects = await listProjects(active.id);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <ProjectsTable projects={projects} />
    </div>
  );
}
