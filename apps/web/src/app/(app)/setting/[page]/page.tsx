import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { SettingsPage } from "@/components/settings-page";
import { isSettingsPageId } from "@/lib/sections";
import { getWorkspaceStorage, getWorkspaceUsage, listProjects, listWorkspaces } from "@/lib/session";

/** One page of Settings, at /setting/{page}. */
export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!isSettingsPageId(page)) notFound();

  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get("ucch_workspace")?.value;
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0];
  // Fetched here rather than in the page: it would otherwise have to
  // discover the active workspace for itself, which the route already knows.
  // Storage walks every project directory, so only the page that shows it
  // pays for it.
  const [usage, storage, projects] = active
    ? await Promise.all([
        getWorkspaceUsage(active.id),
        page === "usage" ? getWorkspaceStorage(active.id) : null,
        listProjects(active.id),
      ])
    : [null, null, []];

  return (
    // Bounded so the forms inside do not stretch to the width of a large
    // monitor -- a label and a field a metre apart is not a form.
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="w-full max-w-3xl">
        <SettingsPage
          page={page}
          usage={usage}
          storage={storage}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />
      </div>
    </div>
  );
}
