import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { SettingsPage } from "@/components/settings-page";
import { isSettingsPageId, workspaceSettingsPageHref } from "@/lib/sections";
import {
  getWorkspaceStorage,
  getWorkspaceUsage,
  listProjects,
  listWorkspaces,
  pickActiveWorkspace,
} from "@/lib/session";
import { WORKSPACE_COOKIE_NAME } from "@/lib/workspace-cookie";

/** One page of Settings, at /setting/{page}. */
export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (page !== "default" && !isSettingsPageId(page)) notFound();

  // Outside any workspace's address, so the one these figures are for is
  // the last one open.
  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get(WORKSPACE_COOKIE_NAME)?.value;
  const active = pickActiveWorkspace(workspaces, requested);
  // The defaults moved to Workspace Settings; old bookmarks follow them.
  if (page === "default") redirect(active ? workspaceSettingsPageHref(active.hash, "general") : "/");
  if (!isSettingsPageId(page)) notFound();
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
