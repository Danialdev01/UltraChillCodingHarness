import { ProjectSkeleton } from "@/components/page-skeletons";

/** Its own boundary, so switching from one session to another paints at once. */
export default function Loading() {
  return <ProjectSkeleton />;
}
