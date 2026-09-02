import { cookies } from "next/headers";

import { AppShell } from "@/components/app-shell";
import { HarnessPanel } from "@/components/harness-panel";
import { listWorkspaces } from "@/lib/session";

export default async function DashboardPage() {
  const workspaces = await listWorkspaces();
  const jar = await cookies();
  const requested = jar.get("ucch_workspace")?.value;
  const active = workspaces.find((w) => w.id === requested) ?? workspaces[0];

  return (
    <AppShell breadcrumb={[active?.name ?? "Workspace", "Projects"]}>
      <div className="flex flex-1 flex-col gap-4 p-4">
        <HarnessPanel workspaceId={active?.id ?? ""} />
      </div>
    </AppShell>
  );
}
