import { HomeHero } from "@/components/home-hero";

/**
 * The root URL, reached from the logo. The page is the greeting; the
 * sidebar panel lists the workspaces to pick from.
 *
 * In a route group of its own so it can have a loading boundary without one
 * at the root of `(app)`, which would wrap every page in the same skeleton.
 */
export default function HomePage() {
  return <HomeHero />;
}
