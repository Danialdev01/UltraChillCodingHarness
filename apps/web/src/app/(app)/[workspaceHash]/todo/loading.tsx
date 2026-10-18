import { SectionPage } from "@/components/section-page";

/**
 * The page has nothing to wait for, so its loading state is the page: a
 * boundary here is what lets the router prefetch it and paint it the instant
 * the URL changes, and the real render then lands on identical pixels.
 */
export default function Loading() {
  return <SectionPage section="todo" />;
}
