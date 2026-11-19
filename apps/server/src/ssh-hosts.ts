import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { sshHosts, type Database, type SshHostRow } from "@ucch/db";
import type { SshAuthMethod, SshHostCreate, SshHostSummary, SshHostUpdate } from "@ucch/protocol";
import { decryptSecret, encryptSecret } from "./crypto.js";

/**
 * Saved SSH hosts, one list per workspace -- the Terminal section's servers.
 *
 * Organisation rather than project activity, so like database connections
 * they sit outside the event log and are served over REST. The password or
 * private key is encrypted on the way in, and decrypted only here, for the
 * moment a connection is made: nothing that leaves this module for the
 * browser carries it.
 */
export class SshHostService {
  constructor(private readonly db: Database) {}

  async list(workspaceId: string): Promise<SshHostSummary[]> {
    const rows = await this.db
      .select()
      .from(sshHosts)
      .where(eq(sshHosts.workspaceId, workspaceId))
      .orderBy(asc(sshHosts.createdAt));
    return rows.map(summarizeSshHost);
  }

  /** The full row, secret included; the caller checks the workspace. */
  async get(id: string): Promise<SshHostRow | null> {
    const [row] = await this.db.select().from(sshHosts).where(eq(sshHosts.id, id)).limit(1);
    return row ?? null;
  }

  async create(
    workspaceId: string,
    input: SshHostCreate,
    secretKey: string,
    createdBy: string,
    hostKeySha256: string | null,
  ): Promise<SshHostSummary> {
    const [row] = await this.db
      .insert(sshHosts)
      .values({
        workspaceId,
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        secretEncrypted: encryptSecret(input.secret, secretKey),
        passphraseEncrypted: input.passphrase ? encryptSecret(input.passphrase, secretKey) : null,
        hostKeySha256,
        createdBy,
      })
      .returning();
    return summarizeSshHost(row!);
  }

  /**
   * The row with the change applied. The secret only if a new one came; a
   * new address forgets the pinned host key, since it is another machine.
   */
  async update(
    row: SshHostRow,
    input: SshHostUpdate,
    secretKey: string,
    hostKeySha256: string | null,
  ): Promise<SshHostSummary> {
    const [updated] = await this.db
      .update(sshHosts)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.authMethod !== undefined ? { authMethod: input.authMethod } : {}),
        ...(input.secret !== undefined ? { secretEncrypted: encryptSecret(input.secret, secretKey) } : {}),
        ...(input.passphrase !== undefined
          ? { passphraseEncrypted: input.passphrase ? encryptSecret(input.passphrase, secretKey) : null }
          : {}),
        hostKeySha256,
      })
      .where(eq(sshHosts.id, row.id))
      .returning();
    return summarizeSshHost(updated!);
  }

  async setHostKey(id: string, hostKeySha256: string | null): Promise<SshHostSummary | null> {
    const [updated] = await this.db.update(sshHosts).set({ hostKeySha256 }).where(eq(sshHosts.id, id)).returning();
    return updated ? summarizeSshHost(updated) : null;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.db.delete(sshHosts).where(eq(sshHosts.id, id)).returning({ id: sshHosts.id });
    return removed.length > 0;
  }
}

export function summarizeSshHost(row: SshHostRow): SshHostSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.authMethod as SshAuthMethod,
    hasPassphrase: row.passphraseEncrypted !== null,
    hostKeySha256: row.hostKeySha256,
    createdAt: row.createdAt.toISOString(),
  };
}

// -- Connecting --------------------------------------------------------------

/** Everything a connection needs, decrypted. Never leaves the server. */
export interface SshTarget {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  secret: string;
  passphrase?: string;
  /** The pinned host key; null trusts whatever is presented and reports it. */
  hostKeySha256: string | null;
}

/** The stored row, decrypted. Throws `SshSecretError` under a changed `SECRET_KEY`. */
export function targetOf(row: SshHostRow, secretKey: string): SshTarget {
  try {
    return {
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.authMethod as SshAuthMethod,
      secret: decryptSecret(row.secretEncrypted, secretKey),
      ...(row.passphraseEncrypted ? { passphrase: decryptSecret(row.passphraseEncrypted, secretKey) } : {}),
      hostKeySha256: row.hostKeySha256,
    };
  } catch {
    throw new SshSecretError("the stored credentials cannot be read; enter them again");
  }
}

/** The host could not be reached, refused the login, or dropped the connection. */
export class SshConnectError extends Error {}
/** The stored secret cannot be decrypted. */
export class SshSecretError extends Error {}
/** The host presented a key other than the pinned one. */
export class SshHostKeyMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly presented: string,
  ) {
    super(
      `The host key changed: expected ${expected}, the server presented ${presented}. ` +
        "If the server was rebuilt, re-trust it from its settings.",
    );
  }
}

/** `SHA256:...` as `ssh-keygen -l` prints it. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** A connected client, and the host key it was made with. */
export interface SshConnection {
  client: Client;
  hostKeySha256: string;
}

/** Opens and authenticates a connection, refusing a host key other than the pinned one. */
export function connectSsh(target: SshTarget, createClient: () => Client = () => new Client()): Promise<SshConnection> {
  return new Promise((resolve, reject) => {
    const client = createClient();
    let presented: string | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        presented = fingerprintOf(key);
        return target.hostKeySha256 === null || presented === target.hostKeySha256;
      },
      ...(target.authMethod === "password"
        ? { password: target.secret, tryKeyboard: true }
        : { privateKey: target.secret, ...(target.passphrase ? { passphrase: target.passphrase } : {}) }),
    };

    // Servers that only offer keyboard-interactive still ask for the password.
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => (target.authMethod === "password" ? target.secret : "")));
    });
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve({ client, hostKeySha256: presented ?? target.hostKeySha256 ?? "" });
    });
    client.once("error", (error: Error & { level?: string }) => {
      if (presented && target.hostKeySha256 && presented !== target.hostKeySha256) {
        fail(new SshHostKeyMismatch(target.hostKeySha256, presented));
        return;
      }
      fail(new SshConnectError(describeSshError(error)));
    });
    client.once("close", () => fail(new SshConnectError("the connection closed before it was ready")));

    try {
      client.connect(config);
    } catch (error) {
      // A malformed private key is thrown synchronously.
      fail(new SshConnectError(error instanceof Error ? error.message : String(error)));
    }
  });
}

/** Says what went wrong in words a person can act on. */
export function describeSshError(error: Error & { level?: string; code?: string }): string {
  if (error.level === "client-authentication") return "authentication failed: check the user name and the password or key";
  if (error.level === "client-timeout") return "timed out waiting for the server";
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return "the host name could not be resolved";
  if (error.code === "ECONNREFUSED") return "the connection was refused: is SSH running on that port?";
  if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") return "the host is unreachable";
  if (error.code === "ETIMEDOUT") return "timed out connecting";
  return error.message;
}

/**
 * Connects once to learn whether the credentials work, and what host key
 * the server presents. The connection is closed straight after.
 */
export async function probeSsh(target: SshTarget): Promise<string> {
  const { client, hostKeySha256 } = await connectSsh(target);
  client.end();
  return hostKeySha256;
}

// -- A shared connection per host, for files and the agent --------------------

/** What a pooled connection gives: the client, its SFTP session, and the remote home. */
export interface PooledSsh {
  client: Client;
  sftp: SFTPWrapper;
  /** The login's home directory, where a relative path starts. */
  home: string;
  /** Runs a command to completion. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bytes kept of each stream; the rest is dropped and `truncated` set. */
  maxBytes?: number;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
}

interface PoolEntry {
  /** What the connection was made with; a changed row makes a new one. */
  version: string;
  ready: Promise<PooledSsh>;
  timer?: NodeJS.Timeout;
}

/** How long a pooled connection nobody uses stays open. */
const POOL_IDLE_MS = 2 * 60_000;

/**
 * One connection per host for the SFTP routes and the agent's commands, so
 * browsing a folder does not pay a handshake per click. Kept while it is in
 * use and closed after a quiet couple of minutes, or as soon as it drops.
 */
export class SshPool {
  readonly #entries = new Map<string, PoolEntry>();

  constructor(private readonly connect: (target: SshTarget) => Promise<SshConnection> = (t) => connectSsh(t)) {}

  async get(row: SshHostRow, target: SshTarget): Promise<PooledSsh> {
    const version = `${row.host}:${row.port}:${row.username}:${row.secretEncrypted}:${row.hostKeySha256 ?? ""}`;
    let entry = this.#entries.get(row.id);
    if (entry && entry.version !== version) {
      this.drop(row.id);
      entry = undefined;
    }
    if (!entry) {
      const created: PoolEntry = { version, ready: this.#open(row.id, target) };
      entry = created;
      this.#entries.set(row.id, created);
      // A failed connection is not kept: the next request tries again.
      created.ready.catch(() => {
        if (this.#entries.get(row.id) === created) this.#entries.delete(row.id);
      });
    }
    this.#touch(row.id, entry);
    return entry.ready;
  }

  /** Closes a host's connection, after its row changed or went. */
  drop(hostId: string): void {
    const entry = this.#entries.get(hostId);
    if (!entry) return;
    this.#entries.delete(hostId);
    clearTimeout(entry.timer);
    entry.ready.then((pooled) => pooled.client.end(), () => {});
  }

  closeAll(): void {
    for (const id of [...this.#entries.keys()]) this.drop(id);
  }

  #touch(hostId: string, entry: PoolEntry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.#entries.get(hostId) === entry) this.drop(hostId);
    }, POOL_IDLE_MS);
    entry.timer.unref();
  }

  async #open(hostId: string, target: SshTarget): Promise<PooledSsh> {
    const { client } = await this.connect(target);
    const forget = () => {
      const entry = this.#entries.get(hostId);
      if (entry) {
        this.#entries.delete(hostId);
        clearTimeout(entry.timer);
      }
    };
    client.on("close", forget);
    client.on("error", forget);
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
        client.sftp((error, session) => (error ? reject(error) : resolve(session))),
      );
      const home = await new Promise<string>((resolve) =>
        sftp.realpath(".", (error, path) => resolve(error ? "/" : path)),
      );
      return { client, sftp, home, exec: (command, options) => execOn(client, command, options) };
    } catch (error) {
      client.end();
      throw new SshConnectError(`SFTP is not available on this server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Runs one command on a connection, collecting its output within bounds. */
export function execOn(client: Client, command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    client.exec(command, (error, channel: ClientChannel) => {
      if (error) {
        reject(new SshConnectError(error.message));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      const keep = (into: Buffer[], chunk: Buffer, used: number): number => {
        if (used >= maxBytes) {
          truncated = true;
          return used;
        }
        const room = maxBytes - used;
        if (chunk.length > room) truncated = true;
        into.push(chunk.subarray(0, room));
        return used + Math.min(chunk.length, room);
      };
      channel.on("data", (chunk: Buffer) => {
        outBytes = keep(out, chunk, outBytes);
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        errBytes = keep(err, chunk, errBytes);
      });
      channel.on("exit", (code: number | null, signal?: string) => {
        exitCode = code;
        exitSignal = signal ?? null;
      });
      const stop = () => {
        try {
          channel.signal("KILL");
        } catch {
          /* not every server takes signals */
        }
        channel.close();
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs)
        : undefined;
      const onAbort = () => stop();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      channel.on("close", () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          exitCode,
          signal: exitSignal,
          timedOut,
          truncated,
        });
      });
      if (options.stdin !== undefined) channel.end(options.stdin);
      else channel.end();
    });
  });
}
