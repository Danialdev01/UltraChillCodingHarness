import { PublicNotesSkeleton } from "@/components/page-skeletons";

/** Its own boundary, so moving between a public site's notes paints at once. */
export default function Loading() {
  return <PublicNotesSkeleton />;
}
