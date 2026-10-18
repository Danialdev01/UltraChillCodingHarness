import type { AssignableRole, CredentialPolicy, WorkspaceRole } from "@ucch/protocol";

/**
 * The workspace writes the switcher and its Manage dialog make. REST rather
 * than commands: workspaces are organisation, not project activity (see the
 * server's `WorkspaceService`).
 */

async function send(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Something went wrong.");
  }
}

export function updateWorkspace(
  workspaceId: string,
  patch: { name?: string; archived?: boolean; logo?: string | null },
): Promise<void> {
  return send(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

/** Only an empty workspace; the server refuses one that still has projects. */
export function deleteWorkspace(workspaceId: string): Promise<void> {
  return send(`/api/workspaces/${workspaceId}`, { method: "DELETE", body: "{}" });
}

/** Longest side of a stored logo. Twice the switcher's 32px, for sharp HiDPI. */
const LOGO_SIZE = 128;

/**
 * Shrinks an image file to a `LOGO_SIZE` square data URL, cropped to the
 * centre, as WebP. Done here so the server only ever stores a few KB, and so SVG and
 * other formats arrive as the plain raster the server accepts.
 */
export async function logoDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("That file is not an image this browser can read.");
    });
    const width = image.naturalWidth || LOGO_SIZE;
    const height = image.naturalHeight || LOGO_SIZE;
    const side = Math.min(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = LOGO_SIZE;
    canvas.height = LOGO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read the image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      (width - side) / 2,
      (height - side) / 2,
      side,
      side,
      0,
      0,
      LOGO_SIZE,
      LOGO_SIZE,
    );
    // WebP keeps transparency at a fraction of PNG's size; a browser
    // without a WebP encoder hands back PNG instead, which the server takes.
    const dataUrl = canvas.toDataURL("image/webp", 0.9);
    if (dataUrl.length > 64 * 1024) throw new Error("That image is too detailed for a logo.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "3 projects", "1 session". */
export function countLabel(workspace: { kind: string; projectCount: number }): string {
  const noun = workspace.kind === "session" ? "session" : "project";
  return `${workspace.projectCount} ${noun}${workspace.projectCount === 1 ? "" : "s"}`;
}

// -- Members, invites and the harness subscription ---------------------------

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Something went wrong.");
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export interface WorkspaceMember {
  userId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: WorkspaceRole;
  canCreateProject: boolean | null;
  canCreateSession: boolean | null;
  joinedAt: string;
}

export interface WorkspaceInvite {
  id: string;
  role: AssignableRole;
  expiresAt: string;
  uses: number;
  maxUses: number | null;
  createdAt: string;
}

export interface InvitePreview {
  workspaceId: string;
  workspaceHash: string;
  workspaceName: string;
  ownerName: string;
  role: AssignableRole;
  alreadyMember: boolean;
}

export interface WorkspaceHarnessSettings {
  credentialPolicy: CredentialPolicy;
  credentials: { openrouter: boolean; claudeToken: boolean; claudeTokenIssuedAt: string | null };
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return (await json<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`)).members;
}

export function addMember(workspaceId: string, identifier: string, role: AssignableRole): Promise<unknown> {
  return json(`/api/workspaces/${workspaceId}/members`, {
    method: "POST",
    body: JSON.stringify({ identifier, role }),
  });
}

export function updateMember(
  workspaceId: string,
  userId: string,
  patch: { role?: AssignableRole; canCreateProject?: boolean | null; canCreateSession?: boolean | null },
): Promise<unknown> {
  return json(`/api/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Removes a member, or -- with your own id -- leaves the workspace. */
export function removeMember(workspaceId: string, userId: string): Promise<unknown> {
  return json(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE", body: "{}" });
}

export async function listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  return (await json<{ invites: WorkspaceInvite[] }>(`/api/workspaces/${workspaceId}/invites`)).invites;
}

export function createInvite(
  workspaceId: string,
  input: { role: AssignableRole; expiresInDays: number; maxUses: number | null },
): Promise<{ token: string; invite: WorkspaceInvite }> {
  return json(`/api/workspaces/${workspaceId}/invites`, { method: "POST", body: JSON.stringify(input) });
}

export function revokeInvite(workspaceId: string, inviteId: string): Promise<unknown> {
  return json(`/api/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE", body: "{}" });
}

/** The address someone opens to join: shown once, when the link is made. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${encodeURIComponent(token)}`;
}

export function previewInvite(token: string): Promise<InvitePreview> {
  return json(`/api/invites/${encodeURIComponent(token)}`);
}

export function acceptInvite(token: string): Promise<{ workspaceId: string; workspaceHash: string }> {
  return json(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST", body: "{}" });
}

export function fetchHarnessSettings(workspaceId: string): Promise<WorkspaceHarnessSettings> {
  return json(`/api/workspaces/${workspaceId}/settings`);
}

export function setCredentialPolicy(
  workspaceId: string,
  credentialPolicy: CredentialPolicy,
): Promise<WorkspaceHarnessSettings> {
  return json(`/api/workspaces/${workspaceId}/settings`, {
    method: "PATCH",
    body: JSON.stringify({ credentialPolicy }),
  });
}

/** Stores, or with `null` clears, one of the workspace's dedicated credentials. */
export function setWorkspaceCredential(
  workspaceId: string,
  kind: "openrouter" | "claude-token",
  value: string | null,
): Promise<WorkspaceHarnessSettings> {
  return json(`/api/workspaces/${workspaceId}/credentials/${kind}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}
