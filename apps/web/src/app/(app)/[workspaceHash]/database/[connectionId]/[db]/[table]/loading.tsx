import { DatabaseViewSkeleton } from "@/components/page-skeletons";

/** Its own boundary, so a click from one table to the next paints at once; the column stays. */
export default function Loading() {
  return <DatabaseViewSkeleton />;
}
