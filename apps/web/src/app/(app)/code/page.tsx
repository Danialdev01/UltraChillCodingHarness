import { cookies } from "next/headers";

import { ProjectsTable } from "@/components/projects-table";
import { listProjects, listWorkspaces } from "@/lib/session";

/**
 * Code: every project in the workspace, as a table.
 *
 * The section blurb that used to stand here said what the page was for to a
 * reader who was already looking at it. The projects say it better.
 */
export default async function CodePage() {
  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get("ucch_workspace")?.value;
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0];
  const projects = await listProjects(active?.id ?? "");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <ProjectsTable projects={projects} />
    </div>
  );
}
