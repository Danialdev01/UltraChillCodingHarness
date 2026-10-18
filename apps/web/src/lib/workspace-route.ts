import { notFound, redirect } from "next/navigation";

import { HASH, projectHref, type ProjectKind } from "@/lib/sections";
import { getProjectByHash, getWorkspaceByHash, type Project, type Workspace } from "@/lib/session";

/**
 * Where an old `/{projectHash}` address now lives, `/{ws}/p|s/{projectHash}`,
 * or null when the hash is not a project of the caller's either.
 */
async function movedProject(hash: string): Promise<string | null> {
  const project = await getProjectByHash(hash);
  if (!project?.workspaceHash) return null;
  return projectHref(project.workspaceHash, project.workspaceKind ?? "project", project.hash);
}

/**
 * The workspace a page under `/{ws}` is in.
 *
 * A hash that names no workspace of the caller's may be a bookmark from
 * before workspaces had addresses, when a project lived at `/{projectHash}`:
 * that redirects to where the project is now, with `rest` -- the path below
 * the hash -- carried along. Anything else 404s, and the format is checked
 * before any lookup so arbitrary paths never reach the API.
 */
export async function requireWorkspace(hash: string, rest = ""): Promise<Workspace> {
  if (!HASH.test(hash)) notFound();
  const workspace = await getWorkspaceByHash(hash);
  if (workspace) return workspace;
  const moved = await movedProject(hash);
  if (moved) redirect(`${moved}${rest}`);
  notFound();
}

/**
 * The project a page under `/{ws}/p|s/{projectHash}` is about.
 *
 * Null from the API means both "does not exist" and "not yours", and this
 * does not tell them apart either. A project of the caller's reached under
 * the wrong workspace or the wrong kind -- a link copied before it moved --
 * is sent to its own address rather than refused.
 */
export async function requireProject(ws: string, projectHash: string, kind: ProjectKind): Promise<Project> {
  if (!HASH.test(ws) || !HASH.test(projectHash)) notFound();
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();
  const actualKind = project.workspaceKind ?? "project";
  if (project.workspaceHash && (project.workspaceHash !== ws || actualKind !== kind)) {
    redirect(projectHref(project.workspaceHash, actualKind, project.hash));
  }
  return project;
}
