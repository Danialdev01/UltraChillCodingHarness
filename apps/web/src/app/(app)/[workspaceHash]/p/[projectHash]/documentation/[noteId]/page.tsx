import { notFound } from "next/navigation";

import { NOTE_ID } from "@/lib/sections";

/**
 * One page of a project's notes, at /{ws}/p/{project_hash}/documentation/{noteId}.
 *
 * The workspace is the layout's; this page only checks the id's shape, so a
 * stray path 404s before the client asks the API for it. Whether the page
 * exists is the workspace's question, answered once the tree has loaded.
 */
export default async function Page({ params }: { params: Promise<{ noteId: string }> }) {
  const { noteId } = await params;
  if (!NOTE_ID.test(noteId)) notFound();
  return null;
}
