import { cookies } from "next/headers";
import type { DatabaseConnectionSummary } from "@ucch/protocol";

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
  threadCount?: number;
  /** Every token the project's turns were billed for, and what they cost. */
  tokens?: number;
  costUsd?: number;
  /** The port the owner's dev server listens on; null until set. */
  previewPort?: number | null;
  /** The subdomain the preview proxy serves, once a port is set. */
  previewUrl?: string | null;
  /** The shareable `/{hash}/preview` entry point on this app. */
  previewAliasUrl?: string;
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

/** Saved database servers in a workspace. Empty when the workspace is not the caller's. */
export async function listDatabaseConnections(workspaceId: string): Promise<DatabaseConnectionSummary[]> {
  if (!workspaceId) return [];
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
}

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
