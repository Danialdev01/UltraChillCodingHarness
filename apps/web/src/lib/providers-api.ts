/**
 * The browser's view of the agent providers: three cards, and the few
 * things a person can do to them from Settings. Everything here is
 * write-only where it touches a credential -- a token goes up and never
 * comes back.
 */

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
  models: { id: string; name: string }[];
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

export async function fetchProviders(fresh = false): Promise<ProvidersResponse> {
  return check(
    await fetch(`/api/providers${fresh ? "?fresh=1" : ""}`, { credentials: "include" }),
  );
}

export async function saveClaudeToken(token: string | null): Promise<void> {
  await check(
    await fetch("/api/settings/claude-token", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
}

export async function signOutProvider(id: "claude" | "codex"): Promise<void> {
  await check(
    await fetch(`/api/providers/${id}/credentials`, { method: "DELETE", credentials: "include" }),
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
