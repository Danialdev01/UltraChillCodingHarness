import { z } from "zod";

export * from "./ssh-paths.js";

/**
 * The Terminal section: machines a workspace reaches over SSH.
 *
 * A host is saved once per workspace, with its credentials -- a password or
 * a private key -- encrypted on the server. Nothing secret ever comes back:
 * the browser sees a `SshHostSummary`, opens shells by the host's id, and
 * browses its files over SFTP through the server.
 */

export const SSH_AUTH_METHODS = ["password", "key"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** A saved host as the panel lists it. Credentials never cross the wire. */
export interface SshHostSummary {
  id: string;
  workspaceId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** Whether the stored key has a passphrase; never the passphrase. */
  hasPassphrase: boolean;
  /** The host key as first seen, `SHA256:...`; null before the first connection. */
  hostKeySha256: string | null;
  /** ISO date. */
  createdAt: string;
}

const SshHostFields = {
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  authMethod: z.enum(SSH_AUTH_METHODS),
  /** The password, or the private key's text (OpenSSH or PEM). */
  secret: z.string().min(1).max(16_384),
  /** A private key's passphrase; empty or absent when it has none. */
  passphrase: z.string().max(1024).optional(),
};

export const SshHostCreate = z.object(SshHostFields);
export type SshHostCreate = z.infer<typeof SshHostCreate>;

/**
 * A change to a saved host. Every field is optional, the secret most of
 * all: the form never sees the stored one, so leaving it out keeps it.
 */
export const SshHostUpdate = z.object(SshHostFields).partial();
export type SshHostUpdate = z.infer<typeof SshHostUpdate>;

/** Opening a shell on a host: the id the client minted and subscribed to first. */
export const SshTerminalOpen = z.object({
  terminalId: z.string().uuid(),
  cols: z.number().int().positive().max(1000).default(80),
  rows: z.number().int().positive().max(1000).default(24),
});
export type SshTerminalOpen = z.infer<typeof SshTerminalOpen>;

// -- Files over SFTP ---------------------------------------------------------

/** One row of a remote folder listing. `path` is absolute. */
export interface RemoteEntry {
  path: string;
  name: string;
  kind: "file" | "folder" | "link";
  /** Bytes, for a file. */
  size?: number;
  /** ISO date. */
  modifiedAt?: string;
}

export const RemoteFolderCreate = z.object({ path: z.string().min(1).max(4096) });
export const RemoteMove = z.object({ from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) });

/** Saving a text file from the editor; `ifVersion` refuses a write over someone else's. */
export const RemoteTextWrite = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
  ifVersion: z.string().max(128).optional(),
});
export type RemoteTextWrite = z.infer<typeof RemoteTextWrite>;

// -- The agent beside the terminals ------------------------------------------

/**
 * A message to the agent that works on a host. `chatId` is minted by the
 * client and names the conversation; the server keeps its history while it
 * is in use.
 */
export const RemoteChatSend = z.object({
  chatId: z.string().uuid(),
  text: z.string().trim().min(1).max(20_000),
  /** Terminal text the person selected, quoted to the agent as context. */
  selection: z.string().max(20_000).optional(),
  /** `@keyId/model` or a plain model id; absent means the account's default. */
  model: z.string().min(1).max(200).optional(),
});
export type RemoteChatSend = z.infer<typeof RemoteChatSend>;

/** Answering the agent's request to run a command or change a file. */
export const RemoteChatPermissionReply = z.object({
  requestId: z.string().min(1).max(100),
  behavior: z.enum(["allow", "deny"]),
  /** `session`: allow every later request in this conversation too. */
  scope: z.enum(["once", "session"]).default("once"),
});
export type RemoteChatPermissionReply = z.infer<typeof RemoteChatPermissionReply>;
