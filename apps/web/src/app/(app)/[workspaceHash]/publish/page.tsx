import { redirect } from "next/navigation";

import { sectionById, sectionHref } from "@/lib/sections";

/** The old Publish placeholder's address, for bookmarks: the Terminal section took its place on the rail. */
export default async function PublishPage({ params }: { params: Promise<{ workspaceHash: string }> }) {
  const { workspaceHash } = await params;
  redirect(sectionHref(sectionById("terminal"), workspaceHash));
}
