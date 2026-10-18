import { notFound, redirect } from "next/navigation";

import { PROJECT_HASH, projectPageHref } from "@/lib/sections";

/**
 * The project's activity log used to live here. It is a tab on the manage
 * page now; the old address keeps working for links and bookmarks.
 */
export default async function Page({ params }: { params: Promise<{ workspaceHash: string; projectHash: string }> }) {
  const { workspaceHash, projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  redirect(`${projectPageHref(workspaceHash, projectHash, "manage")}?tab=activity`);
}
