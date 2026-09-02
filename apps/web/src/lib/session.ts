import { cookies } from "next/headers";

export interface Session {
  userId: string;
  scopes: string[];
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/**
 * Resolves the current session on the server.
 *
 * The cookie is forwarded to the API directly rather than through the browser
 * rewrite, so this is one server-to-server hop. Presence of the cookie is not
 * treated as proof of anything -- only the API can say whether a session is
 * still valid, and it is the component that can expire or revoke it.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/me`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as Session;
  } catch {
    // The API being unreachable is not the same as being signed out, but from
    // the page's point of view there is nothing to render either way.
    return null;
  }
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  projectCount: number;
}

/**
 * The caller's workspaces, seeded with a default by the API if there are
 * none. Returns empty only when the request itself failed, which the caller
 * renders as "no workspace" rather than treating as signed out.
 */
export async function listWorkspaces(): Promise<Workspace[]> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return [];

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return ((await response.json()) as { workspaces: Workspace[] }).workspaces;
  } catch {
    return [];
  }
}

export interface Project {
  id: string;
  hash: string;
  name: string;
  stack: string;
  containerState: string;
}

/** Projects in a workspace. Empty when the workspace is not the caller's. */
export async function listProjects(workspaceId: string): Promise<Project[]> {
  if (!workspaceId) return [];
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return [];

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces/${workspaceId}/projects`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return ((await response.json()) as { projects: Project[] }).projects;
  } catch {
    return [];
  }
}

/** A single project by public hash, or null if it is not the caller's. */
export async function getProjectByHash(hash: string): Promise<Project | null> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/projects/${hash}`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as Project;
  } catch {
    return null;
  }
}
