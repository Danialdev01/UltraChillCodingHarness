import type { CredentialSource } from "@ucch/protocol";

/**
 * Which subscription your new sessions in a workspace run on, when the
 * workspace lets members choose (`either`). Remembered per browser and per
 * workspace; the server binds the choice to the thread when it is created,
 * so changing it later never moves a running conversation.
 */
const key = (workspaceId: string) => `ucch:credential-source:${workspaceId}`;

export function readCredentialChoice(workspaceId: string | undefined): CredentialSource | undefined {
  if (!workspaceId) return undefined;
  try {
    const value = globalThis.localStorage?.getItem(key(workspaceId));
    return value === "workspace" || value === "member" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeCredentialChoice(workspaceId: string, choice: CredentialSource): void {
  try {
    globalThis.localStorage?.setItem(key(workspaceId), choice);
  } catch {
    /* not remembered */
  }
}
