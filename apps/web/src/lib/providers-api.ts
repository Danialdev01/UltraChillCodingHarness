/**
 * The browser's view of the agent providers: three cards, and the few
 * things a person can do to them from Settings. Everything here is
 * write-only where it touches a credential -- a token goes up and never
 * comes back.
 */

import type { ReasoningEffort } from "@ucch/protocol"

export type ProviderId = "native" | "claude" | "codex";

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
  token?: { configured: boolean; issuedAt: string | null; expiresSoon: boolean };
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

export async function saveClaudeToken(token: string | null, workspaceId?: string): Promise<void> {
  await check(
    await fetch(workspaceId ? `/api/workspaces/${workspaceId}/credentials/claude-token` : "/api/settings/claude-token", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workspaceId ? { value: token } : { token }),
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
