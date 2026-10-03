import { notFound } from "next/navigation";

import { PublicNotes } from "@/components/public/public-notes";

const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The notes, at `/{slug}/notes` and `/{slug}/notes/{noteId}`. */
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string; noteId?: string[] }>;
}) {
  const { slug, noteId } = await params;
  const id = noteId?.[0] ?? null;
  if (noteId && (noteId.length !== 1 || !NOTE_ID.test(id!))) notFound();
  return <PublicNotes slug={slug} noteId={id} />;
}
