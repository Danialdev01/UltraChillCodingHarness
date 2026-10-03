import { notFound } from "next/navigation";

import { PublicShell } from "@/components/public/public-shell";
import { fetchPublicProject } from "@/lib/public-api";

/**
 * A project's public site: what the owner chose to show, read-only, to
 * anyone with the address.
 *
 * Reached as `/{slug}/…` through the middleware rewrite. Outside the `(app)`
 * group on purpose: no session is looked up, no sidebar or workspace is
 * rendered, and a visitor who is also the owner sees exactly what a
 * stranger would. An address that is unknown or switched off 404s here,
 * before any page under it asks for anything.
 */
export default async function PublicLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;
  const project = await fetchPublicProject(slug);
  if (!project) notFound();
  return <PublicShell project={project}>{children}</PublicShell>;
}
