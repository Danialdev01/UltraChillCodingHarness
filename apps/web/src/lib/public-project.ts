import { apiFetch } from "./api-agent";
import type { PublicProject } from "./public-api";

/** From a server component: null when there is no such site or it is off. */
export async function fetchPublicProject(slug: string): Promise<PublicProject | null> {
  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await apiFetch(`${origin}/api/public/${slug}`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as PublicProject) : null;
  } catch {
    return null;
  }
}
