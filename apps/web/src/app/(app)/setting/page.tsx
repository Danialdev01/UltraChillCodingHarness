import { cookies } from "next/headers";

import { SettingsTabs } from "@/components/settings-tabs";
import { getWorkspaceUsage, listProjects, listWorkspaces } from "@/lib/session";

export default async function SettingPage() {
  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get("ucch_workspace")?.value;
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0];
  // Fetched here rather than in the tab: the panel would otherwise have to
  // discover the active workspace for itself, which the page already knows.
  const [usage, projects] = active
    ? await Promise.all([getWorkspaceUsage(active.id), listProjects(active.id)])
    : [null, []];

  return (
    // Bounded so the forms inside do not stretch to the width of a large
    // monitor -- a label and a field a metre apart is not a form.
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="w-full max-w-3xl">
        <SettingsTabs usage={usage} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
      </div>
    </div>
  );
}
