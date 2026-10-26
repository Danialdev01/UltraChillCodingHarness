import { z } from "zod";
import { WORKSPACE_PERMISSIONS, WORKSPACE_ROLES } from "./plain.js";

/**
 * Who a person is in a workspace.
 *
 *   owner   created it; everything, and cannot be removed or demoted.
 *   admin   everything except deleting the workspace or touching the owner.
 *   member  works in it: creates projects and sessions, talks to agents.
 *   viewer  reads only.
 *
 * Shared between server and web so the UI hides exactly what the server
 * would refuse.
 */
export const WorkspaceRole = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/** The roles a person can be given -- `owner` is only ever the creator. */
export const AssignableRole = z.enum(["admin", "member", "viewer"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

export const WorkspacePermission = z.enum(WORKSPACE_PERMISSIONS);
export type WorkspacePermission = z.infer<typeof WorkspacePermission>;

/**
 * Whose harness subscription a workspace's turns run on.
 *
 *   member     each person's own Claude Code / OpenRouter / Codex login.
 *   workspace  the workspace's dedicated credentials, for everyone.
 *   either     chosen per session when it is started.
 */
export const CredentialPolicy = z.enum(["member", "workspace", "either"]);
export type CredentialPolicy = z.infer<typeof CredentialPolicy>;

export const CredentialSource = z.enum(["member", "workspace"]);
export type CredentialSource = z.infer<typeof CredentialSource>;

export interface Membership {
  role: WorkspaceRole;
  /** Null follows the role's default. */
  canCreateProject: boolean | null;
  canCreateSession: boolean | null;
}

// What each role may do, and who may manage whom: `plain.ts`, for the browser.

/**
 * Whose credentials a new thread binds to. Under `either` the starter's
 * choice wins, defaulting to their own.
 */
export function resolveCredentialSource(
  policy: CredentialPolicy,
  requested?: CredentialSource | null,
): CredentialSource {
  if (policy === "either") return requested ?? "member";
  return policy;
}

/**
 * Whose credentials a turn on an existing thread runs on. A fixed policy
 * overrides what the thread was started with, so switching a workspace to
 * dedicated credentials takes effect for old threads too.
 */
export function effectiveCredentialSource(
  policy: CredentialPolicy,
  bound: CredentialSource | null | undefined,
): CredentialSource {
  if (policy === "either") return bound ?? "member";
  return policy;
}
