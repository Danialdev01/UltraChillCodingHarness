import { cache } from "react";
import { cookies, headers } from "next/headers";
import { WORKSPACE_COOKIE_NAME } from "./workspace-cookie";
import { WORKSPACE_HEADER } from "./workspace-header";
import type {
  CredentialPolicy,
  DatabaseConnectionSummary,
  WorkspacePermission,
  WorkspaceRole,
} from "@ucch/protocol";

export interface Session {
  userId: string;
  scopes: string[];
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

// The lookups a layout and the page inside it both make are wrapped in
// React's `cache`, so one render asks the API once however many components
// want the session, the workspaces, or the project.

/**
 * Everything the shell needs about the signed-in person, from one request
 * (`GET /api/bootstrap`): who they are, their workspaces, which one is open
 * and its projects and connections.
 *
 * Wrapped in React's `cache`, so the layout and the page inside it -- and
 * every component that asks for the session, the workspaces or the open
 * workspace's projects -- share the one round trip. The workspace in the
 * address (the middleware's header) decides which is open, then the cookie's
 * last one.
 *
 * The cookie is forwarded to the API directly rather than through the browser
 * rewrite, so this is one server-to-server hop. Presence of the cookie is not
 * treated as proof of anything -- only the API can say whether a session is
 * still valid, and it is the component that can expire or revoke it.
 */
export interface Bootstrap {
  buildId: string;
  me: Session & { hasPassword: boolean };
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  projects: Project[];
  connections: DatabaseConnectionSummary[];
}

export const getBootstrap = cache(async function getBootstrap(): Promise<Bootstrap | null> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const params = new URLSearchParams();
  const ws = (await headers()).get(WORKSPACE_HEADER);
  if (ws) params.set("ws", ws);
  const hint = jar.get(WORKSPACE_COOKIE_NAME)?.value;
  if (hint) params.set("hint", hint);

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/bootstrap?${params}`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as Bootstrap;
  } catch {
    // The API being unreachable is not the same as being signed out, but from
    // the page's point of view there is nothing to render either way.
    return null;
  }
});

/** The current session, or null when there is none (or the API cannot say). */
export const getSession = cache(async function getSession(): Promise<Session | null> {
  return (await getBootstrap())?.me ?? null;
});

export type WorkspaceKind = "project" | "session";

export interface Workspace {
  id: string;
  slug: string;
  /** Its address in the app, `/{hash}`. */
  hash: string;
  name: string;
  /** Named projects, or quick sessions that each open straight into chat. */
  kind: WorkspaceKind;
  archived: boolean;
  projectCount: number;
  /** A small `data:image/...` URL set in Manage workspace, or null. */
  logo: string | null;
  /** The caller's role here, and everything it lets them do. */
  role: WorkspaceRole;
  permissions: WorkspacePermission[];
  /** Owned by somebody else; the caller is a member. */
  shared: boolean;
  ownerName: string;
  /** Whose harness subscription its turns run on. */
  credentialPolicy: CredentialPolicy;
}

/**
 * The workspace the shell has open.
 *
 * The URL decides when it names one (`hash`, from `/{ws}/…`) -- archived or
 * not, since it was asked for by address. Otherwise the cookie's last
 * workspace, unless it is gone or archived -- then the first one still in
 * use. An archived workspace is only ever looked at from the switcher's
 * Archived group or its own address, never landed in by default.
 */
export function pickActiveWorkspace(
  workspaces: Workspace[],
  requested: string | undefined,
  hash?: string | null,
): Workspace | undefined {
  const addressed = hash ? workspaces.find((w) => w.hash === hash) : undefined;
  if (addressed) return addressed;
  const live = workspaces.filter((w) => !w.archived);
  return live.find((w) => w.id === requested) ?? live[0] ?? workspaces[0];
}


/**
 * The caller's workspaces, seeded with a default by the API if there are
 * none. Returns empty only when the request itself failed, which the caller
 * renders as "no workspace" rather than treating as signed out.
 */
export const listWorkspaces = cache(async function listWorkspaces(): Promise<Workspace[]> {
  return (await getBootstrap())?.workspaces ?? [];
});

export interface Project {
  id: string;
  hash: string;
  name: string;
  stack: string;
  containerState: string;
  workspaceId?: string;
  /** The project's workspace address and kind: what its URL is built from. */
  workspaceHash?: string;
  workspaceKind?: WorkspaceKind;
  /**
   * The columns the project tables show and the sidebar has no room for.
   * Optional because `getProjectByHash` serves the single-project shape,
   * which does not carry them.
   */
  repoUrl?: string | null;
  defaultBranch?: string;
  /** ISO strings: JSON has no date, and nothing here needs one. */
  lastActiveAt?: string;
  createdAt?: string;
  running?: boolean;
  /** The latest turn failed or hit a limit: the sidebar's red dot. */
  failed?: boolean;
  threadCount?: number;
  /** Every token the project's turns were billed for, and what they cost. */
  tokens?: number;
  costUsd?: number;
  /** The port the owner's dev server listens on; null until set. */
  previewPort?: number | null;
  /** Set when the preview is a static site: the working-tree folder it serves, "" for the root. */
  previewStaticDir?: string | null;
  /** The subdomain the preview proxy serves, once a port is set. */
  previewUrl?: string | null;
  /** The shareable `/{hash}/preview` entry point on this app. */
  previewAliasUrl?: string;
  /**
   * Set on the copy a project session's page hands the files panel, the
   * terminal and git: the session whose worktree they work in. Never on a
   * project as the API returns it.
   */
  sessionHash?: string | null;
}

/** What the account's OpenRouter key has left. Mirrors the server's `KeyQuota`. */
export interface OpenRouterQuota {
  label: string | null;
  usageUsd: number;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  freeTier: boolean;
  credits: { totalUsd: number; usedUsd: number } | null;
}

/**
 * The quota, or why there is none to show.
 *
 * Three states rather than null: a missing key and an unreachable OpenRouter
 * call for different words on the card, and collapsing them would tell the
 * person to add a key they already have.
 */
export type QuotaResult =
  | { status: "ok"; quota: OpenRouterQuota }
  | { status: "no_key" }
  | { status: "unavailable" };

export async function getOpenRouterQuota(): Promise<QuotaResult> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return { status: "unavailable" };

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/account/openrouter/quota`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (response.status === 404) return { status: "no_key" };
    if (!response.ok) return { status: "unavailable" };
    return { status: "ok", quota: (await response.json()) as OpenRouterQuota };
  } catch {
    return { status: "unavailable" };
  }
}

/** The Dashboard's headline numbers. Mirrors the server's `WorkspaceStats`. */
export interface WorkspaceStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  costUsd: number;
  turnCount: number;
  projects: { total: number; running: number; containersUp: number };
  previews: { total: number; live: number; expiringSoon: number };
  /** Null while there is no todos table to count. */
  todo: { due: number; open: number } | null;
}

/**
 * The workspace's aggregates, or null when the request failed.
 *
 * Null rather than a zeroed object: a dashboard that shows 0 tokens because
 * the API was unreachable is worse than one that says it could not load.
 */
export async function getWorkspaceStats(workspaceId: string): Promise<WorkspaceStats | null> {
  if (!workspaceId) return null;
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces/${workspaceId}/stats`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as WorkspaceStats;
  } catch {
    return null;
  }
}

/** One project's bill and footprint, for its manage page. Mirrors the server. */
export interface ProjectStats {
  tokens: WorkspaceStats["tokens"];
  costUsd: number;
  turnCount: number;
  /** The project directory on disk, `.git` and `node_modules` included. */
  storageBytes: number;
}

export const getProjectStats = cache(async function getProjectStats(hash: string): Promise<ProjectStats | null> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/projects/${hash}/stats`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as ProjectStats;
  } catch {
    return null;
  }
});

/** One model's share of the workspace's bill. Mirrors the server. */
export interface ModelUsage {
  /** Null on turns recorded before the model was stored with them. */
  model: string | null;
  costUsd: number;
  requests: number;
  tokens: number;
}

/** Spend, requests and tokens for a workspace, split by model. */
export interface WorkspaceUsage {
  totals: { costUsd: number; requests: number; tokens: number };
  models: ModelUsage[];
}

/**
 * The per-model breakdown behind the Usage tab, or null when it failed.
 *
 * Null rather than an empty breakdown, for the same reason `getWorkspaceStats`
 * is: a spend of $0.00 because the API was down reads as a fact.
 */
export async function getWorkspaceUsage(workspaceId: string): Promise<WorkspaceUsage | null> {
  if (!workspaceId) return null;
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces/${workspaceId}/usage`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as WorkspaceUsage;
  } catch {
    return null;
  }
}

/** Projects in a workspace. Empty when the workspace is not the caller's. */
export const listProjects = cache(async function listProjects(workspaceId: string): Promise<Project[]> {
  if (!workspaceId) return [];
  // The open workspace's are already in the bootstrap this request fetched.
  const boot = await getBootstrap();
  if (boot?.activeWorkspaceId === workspaceId) return boot.projects;
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
});

/** Saved database servers in a workspace. Empty when the workspace is not the caller's. */
export const listDatabaseConnections = cache(async function listDatabaseConnections(workspaceId: string): Promise<DatabaseConnectionSummary[]> {
  if (!workspaceId) return [];
  const boot = await getBootstrap();
  if (boot?.activeWorkspaceId === workspaceId) return boot.connections;
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return [];

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces/${workspaceId}/database-connections`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return ((await response.json()) as { connections: DatabaseConnectionSummary[] }).connections;
  } catch {
    return [];
  }
});

/** One saved database server, or null if it is not the caller's. */
export async function getDatabaseConnection(id: string): Promise<DatabaseConnectionSummary | null> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/database-connections/${encodeURIComponent(id)}`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return ((await response.json()) as { connection: DatabaseConnectionSummary }).connection;
  } catch {
    return null;
  }
}

/** A single project by public hash, or null if it is not the caller's. */
export const getProjectByHash = cache(async function getProjectByHash(hash: string): Promise<Project | null> {
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
});

/** A workspace by its address, or null if it does not exist or is not the caller's. */
export const getWorkspaceByHash = cache(async function getWorkspaceByHash(hash: string): Promise<Workspace | null> {
  const workspaces = await listWorkspaces();
  return workspaces.find((w) => w.hash === hash) ?? null;
});

/**
 * One conversation in a project: a thread. In a project workspace each is a
 * session of its own, at `/{ws}/p/{project}/{hash}`, and works in its own
 * git worktree on `branch` (forked from `baseBranch`) once `worktreeState`
 * is `ready`. Both branches null: an older thread that works in the
 * project's main checkout.
 */
export interface ProjectSession {
  id: string;
  hash: string;
  title: string;
  status: string;
  provider: string | null;
  baseBranch: string | null;
  branch: string | null;
  worktreeState: "creating" | "ready" | "error" | null;
  worktreeError: string | null;
  createdAt: string;
}

/** A project's sessions, newest first; empty when the project is not the caller's. */
export const listProjectSessions = cache(async function listProjectSessions(
  projectHash: string,
): Promise<ProjectSession[]> {
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return [];

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/projects/${projectHash}/threads`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return ((await response.json()) as { threads: ProjectSession[] }).threads;
  } catch {
    return [];
  }
});

/** What a workspace occupies on disk and in the database. Mirrors the server. */
export interface WorkspaceStorage {
  /** The workspace's own project directories. */
  files: { bytes: number; projects: { id: string; name: string; bytes: number }[] };
  /** The whole database: rows are not partitioned by workspace. */
  database: { bytes: number; tables: { name: string; bytes: number }[] };
}

/** Disk and database sizes behind the Usage tab, or null when they failed. */
export async function getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorage | null> {
  if (!workspaceId) return null;
  const jar = await cookies();
  const token = jar.get("ucch_session");
  if (!token) return null;

  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const response = await fetch(`${origin}/api/workspaces/${workspaceId}/storage`, {
      headers: { cookie: `ucch_session=${token.value}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as WorkspaceStorage;
  } catch {
    return null;
  }
}
