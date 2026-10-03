import { ProjectSubPage } from "@/components/project-page";

/** A project's manage page, at /{project_hash}/manage. */
export default function Page({ params }: { params: Promise<{ projectHash: string }> }) {
  return <ProjectSubPage params={params} page="manage" />;
}
