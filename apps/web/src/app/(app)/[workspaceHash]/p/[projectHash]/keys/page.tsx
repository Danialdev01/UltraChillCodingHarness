import { notFound, redirect } from "next/navigation";

import { noteHref, PROJECT_HASH } from "@/lib/sections";

/**
 * A project's keys used to live here. They are a tab of the documentation
 * now; the old address keeps working for links and bookmarks.
 */
export default async function Page({ params }: { params: Promise<{ workspaceHash: string; projectHash: string }> }) {
  const { workspaceHash, projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  redirect(`${noteHref(workspaceHash, projectHash, null)}?view=keys`);
}
