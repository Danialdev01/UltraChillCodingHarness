import { redirect } from "next/navigation";

import { workspaceSettingsPageHref } from "@/lib/sections";

/** `/{ws}/workspace-settings` has no content of its own; General is the first page. */
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ workspaceHash: string }> }) {
  const { workspaceHash } = await params;
  redirect(workspaceSettingsPageHref(workspaceHash, "general"));
}
