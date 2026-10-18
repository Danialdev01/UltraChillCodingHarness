import { ProjectManageSkeleton } from "@/components/project-manage";

/** Shown the instant the URL changes, until the project has been looked up. */
export default function Loading() {
  return <ProjectManageSkeleton />;
}
