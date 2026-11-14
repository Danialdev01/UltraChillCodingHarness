/**
 * The browser's view of the agent providers: three cards, and the few
 * things a person can do to them from Settings. Everything here is
 * write-only where it touches a credential -- a token goes up and never
 * comes back.
 */

import type { ReasoningEffort } from "@ucch/protocol"

export type ProviderId = "native" | "claude" | "codex" | "omp";

export interface ProviderCard {
  id: ProviderId;
  label: string;
  installed: boolean;
  authenticated: boolean;
  authMode: "subscription" | "token" | "api-key" | "none";
  /** Masked, e.g. `d***@example.com`. */
  account?: string;
  version?: string;
  error?: string;
  warnings?: string[];
  /** False when the server refuses this provider, whatever its health. */
  enabled: boolean;
  /** `efforts`: the levels the model takes. Absent, it offers no effort control. */
  models: { id: string; name: string; efforts?: ReasoningEffort[] }[];
}

export interface ProvidersResponse {
  providers: Record<ProviderId, ProviderCard>;
  defaultProvider: ProviderId;
  cliEnabled: boolean;
  encryptionAvailable: boolean;
}

async function check<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* no body */
    }
    throw new Error(message);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** `workspaceId`: that workspace's dedicated subscription rather than your own. */
function scoped(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function fetchProviders(fresh = false, workspaceId?: string): Promise<ProvidersResponse> {
  return check(
    await fetch(scoped("/api/providers", { fresh: fresh ? "1" : undefined, workspace: workspaceId }), {
      credentials: "include",
    }),
  );
}

export async function signOutProvider(id: "claude" | "codex", workspaceId?: string): Promise<void> {
  await check(
    await fetch(scoped(`/api/providers/${id}/credentials`, { workspace: workspaceId }), {
      method: "DELETE",
      credentials: "include",
    }),
  );
}

export async function saveDefaultProvider(provider: ProviderId | null): Promise<void> {
  await check(
    await fetch("/api/settings/default-provider", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }),
  );
}

/** Whether a provider can take a turn right now, and if not, why. */
export function providerBlocker(card: ProviderCard): string | null {
  if (card.id === "native") return card.authenticated ? null : "Add an OpenRouter key in Settings";
  if (!card.enabled) return "Disabled on this server";
  if (!card.installed) return `${card.label} is not installed on the server`;
  if (!card.authenticated) return `Sign in to ${card.label} in Settings`;
  return null;
}

/** "Claude subscription", "ChatGPT subscription", "API credits". */
export function billingLabel(provider: string | undefined): string {
  switch (provider) {
    case "claude":
      return "Claude subscription";
    case "codex":
      return "ChatGPT subscription";
    default:
      return "API credits";
  }
}

/** One project's OMP memory, as the memory card shows it (counts only). */
export interface OmpMemoryStats {
  exists: boolean;
  facts: number;
  episodes: number;
  total: number;
  bytes: number;
  lastAt: string | null;
}

export async function fetchOmpMemory(projectId: string, workspaceId?: string): Promise<OmpMemoryStats> {
  return check<OmpMemoryStats>(
    await fetch(scoped(`/api/omp-memory/${encodeURIComponent(projectId)}`, { workspace: workspaceId }), {
      credentials: "include",
      cache: "no-store",
    }),
  );
}

export async function clearOmpMemory(projectId: string, workspaceId?: string): Promise<void> {
  await check(
    await fetch(scoped(`/api/omp-memory/${encodeURIComponent(projectId)}`, { workspace: workspaceId }), {
      method: "DELETE",
      credentials: "include",
    }),
  );
}

// -- Subscription accounts (profiles) ----------------------------------------

export type AccountProvider = "claude" | "codex"
export type AccountContext = "personal" | "work"

/** One Claude Code or Codex login, as Settings → Harness lists it. */
export interface AgentAccount {
  id: string
  provider: AccountProvider
  label: string
  context: AccountContext
  isDefault: boolean
  authStatus: "unknown" | "signed_in" | "signed_out"
  /** ISO while the plan's limit holds; null otherwise. */
  limitedUntil: string | null
  /** The reset time is a guess: the CLI gave none. */
  limitEstimated: boolean
  lastUsedAt: string | null
  installed: boolean
  authenticated: boolean
  authMode: ProviderCard["authMode"]
  account?: string
  error?: string
  warnings?: string[]
  quota: { status: string; windows?: { id: string; label: string; usedPercent: number; resetsAt: string | null }[]; checkedAt?: string } | null
}

export async function fetchAccounts(workspaceId?: string, fresh = false): Promise<AgentAccount[]> {
  const body = await check<{ profiles: AgentAccount[] }>(
    await fetch(scoped("/api/agent-profiles", { workspace: workspaceId, fresh: fresh ? "1" : undefined }), {
      credentials: "include",
      cache: "no-store",
    }),
  )
  return body.profiles
}

export async function createAccount(
  input: { provider: AccountProvider; label: string; context: AccountContext },
  workspaceId?: string,
): Promise<AgentAccount> {
  const body = await check<{ profile: AgentAccount }>(
    await fetch(scoped("/api/agent-profiles", { workspace: workspaceId }), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  )
  return body.profile
}

export async function updateAccount(
  id: string,
  patch: { label?: string; context?: AccountContext },
  workspaceId?: string,
): Promise<void> {
  await check(
    await fetch(scoped(`/api/agent-profiles/${encodeURIComponent(id)}`, { workspace: workspaceId }), {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteAccount(id: string, workspaceId?: string): Promise<void> {
  await check(
    await fetch(scoped(`/api/agent-profiles/${encodeURIComponent(id)}`, { workspace: workspaceId }), {
      method: "DELETE",
      credentials: "include",
    }),
  )
}

export async function signOutAccount(id: string, workspaceId?: string): Promise<void> {
  await check(
    await fetch(scoped(`/api/agent-profiles/${encodeURIComponent(id)}/credentials`, { workspace: workspaceId }), {
      method: "DELETE",
      credentials: "include",
    }),
  )
}

/** A project's account settings: the caller's defaults, and which context it requires. */
export interface ProjectAccounts {
  requiredContext: AccountContext | null
  defaults: Partial<Record<AccountProvider, string>>
  canManage: boolean
}

export async function fetchProjectAccounts(projectHash: string): Promise<ProjectAccounts> {
  return check(
    await fetch(`/api/projects/${encodeURIComponent(projectHash)}/accounts`, { credentials: "include", cache: "no-store" }),
  )
}

export async function saveProjectDefaultAccount(projectHash: string, provider: AccountProvider, profileId: string | null): Promise<void> {
  await check(
    await fetch(`/api/projects/${encodeURIComponent(projectHash)}/accounts/default/${provider}`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId }),
    }),
  )
}

export async function saveProjectRequiredContext(projectHash: string, context: AccountContext | null): Promise<void> {
  await check(
    await fetch(`/api/projects/${encodeURIComponent(projectHash)}/accounts/required-context`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context }),
    }),
  )
}

/** "Signed in", "Limited until 14:05", "Signed out": an account's state in a few words. */
export function accountStatus(account: Pick<AgentAccount, "authStatus" | "limitedUntil" | "limitEstimated">): {
  label: string
  tone: "ok" | "warn" | "muted"
} {
  if (account.limitedUntil) {
    const at = new Date(account.limitedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    return { label: `Limited until ${account.limitEstimated ? "~" : ""}${at}`, tone: "warn" }
  }
  if (account.authStatus === "signed_in") return { label: "Signed in", tone: "ok" }
  if (account.authStatus === "signed_out") return { label: "Signed out", tone: "warn" }
  return { label: "Not checked", tone: "muted" }
}
