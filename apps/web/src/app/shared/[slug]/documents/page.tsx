import { Suspense } from "react";

import { PublicDocumentsSkeleton } from "@/components/page-skeletons";
import { PublicDocuments } from "@/components/public/public-documents";

/** The project's files, read-only, at `/{slug}/documents`. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The viewer reads `?path=` on the client, which Next wants under Suspense.
  return (
    <Suspense fallback={<PublicDocumentsSkeleton />}>
      <PublicDocuments slug={slug} />
    </Suspense>
  );
}
