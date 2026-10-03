import { ProjectPageCard } from "@/components/project-page";

/** Shown the instant the URL changes, until the project has been looked up. */
export default function Loading() {
  return <ProjectPageCard page="manage" />;
}
