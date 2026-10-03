import { redirect } from "next/navigation";

import { publicHref } from "@/lib/public-api";

/** The site opens on its notes. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(publicHref(slug, "notes"));
}
