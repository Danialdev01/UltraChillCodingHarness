import { PublicTimeline } from "@/components/public/public-timeline";

/** The project's history, at `/{slug}/timeline`. */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicTimeline slug={slug} />;
}
