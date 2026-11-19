import type { Readable } from "node:stream";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { normalizeRemotePath, remoteBasename, remoteJoin, type RemoteEntry } from "@ucch/protocol";
import { contentVersion } from "./files.js";
import type { PooledSsh } from "./ssh-hosts.js";

/** Bytes the editor opens: the same ceiling as a project file's. */
export const MAX_REMOTE_READ_BYTES = 1024 * 1024;
/** Bytes the editor saves. */
export const MAX_REMOTE_WRITE_BYTES = 5 * 1024 * 1024;
/** Entries one folder listing returns; a folder with more says so. */
const MAX_LIST_ENTRIES = 5000;
/** Entries a recursive delete walks before refusing: past that, use the shell. */
const MAX_REMOVE_ENTRIES = 10_000;

/** A path that is not one. Reported as 400. */
export class RemotePathError extends Error {}
/** Something is already there. Reported as 409. */
export class RemoteConflictError extends Error {}
/** Nothing is there. Reported as 404. */
export class RemoteMissingError extends Error {}
/** The server refused: permissions, a full disk. Reported as 422 with its words. */
export class RemoteRefusedError extends Error {}
/** Too large to open or save in the editor. Reported as 413. */
export class RemoteTooLargeError extends Error {}
/** Not text. Reported as 415. */
export class RemoteBinaryError extends Error {}
/** Changed since the editor read it. Reported as 409 with what is there now. */
export class RemoteStaleError extends Error {
  constructor(
    readonly content: string | null,
    readonly version: string | null,
  ) {
    super("the file was changed elsewhere");
  }
}

// SFTP status codes (draft-ietf-secsh-filexfer-02 §7).
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

function translate(error: unknown, path: string): Error {
  const code = (error as { code?: number }).code;
  if (code === NO_SUCH_FILE) return new RemoteMissingError(`${path} does not exist`);
  if (code === PERMISSION_DENIED) return new RemoteRefusedError(`permission denied: ${path}`);
  return new RemoteRefusedError(error instanceof Error ? error.message : String(error));
}

function call<T>(path: string, fn: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((error, value) => (error ? reject(translate(error, path)) : resolve(value as T)));
  });
}

function kindOf(stats: Stats): RemoteEntry["kind"] {
  if (stats.isDirectory()) return "folder";
  if (stats.isSymbolicLink()) return "link";
  return "file";
}

/**
 * A host's files over SFTP, for the Terminal section's file panel.
 *
 * Paths are absolute, tidied by `normalizeRemotePath` against the login's
 * home. There is no confinement to keep: whoever may browse a host may also
 * open a shell on it, as the same login.
 */
export class RemoteFiles {
  readonly #sftp: SFTPWrapper;
  readonly home: string;

  constructor(pooled: Pick<PooledSsh, "sftp" | "home">) {
    this.#sftp = pooled.sftp;
    this.home = pooled.home;
  }

  /** A caller's path, made absolute, or a `RemotePathError`. */
  path(raw: string | undefined, allowRoot = true): string {
    const path = normalizeRemotePath(raw ?? "", this.home);
    if (path === null) throw new RemotePathError(`not a valid path: ${raw}`);
    if (path === "/" && !allowRoot) throw new RemotePathError("a file name is required");
    return path;
  }

  /** One level of a folder: folders first, then by name. Links are followed for their kind. */
  async list(dir: string): Promise<{ path: string; entries: RemoteEntry[]; truncated: boolean }> {
    const rows = await call<FileEntryWithStats[]>(dir, (done) => this.#sftp.readdir(dir, done));
    const truncated = rows.length > MAX_LIST_ENTRIES;
    const entries = await Promise.all(
      rows.slice(0, MAX_LIST_ENTRIES).map(async (row): Promise<RemoteEntry> => {
        const path = remoteJoin(dir, row.filename);
        let kind = kindOf(row.attrs as Stats);
        if (kind === "link") {
          // Where a link points decides whether it opens or unfolds.
          const target = await this.#stat(path).catch(() => null);
          if (target) kind = target.isDirectory() ? "folder" : "file";
        }
        return {
          path,
          name: row.filename,
          kind,
          ...(kind === "file" ? { size: row.attrs.size } : {}),
          ...(row.attrs.mtime ? { modifiedAt: new Date(row.attrs.mtime * 1000).toISOString() } : {}),
        };
      }),
    );
    entries.sort((a, b) => {
      const af = a.kind === "folder" ? 0 : 1;
      const bf = b.kind === "folder" ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    return { path: dir, entries, truncated };
  }

  /** What is at a path; null when nothing is. */
  async kind(path: string): Promise<"file" | "folder" | null> {
    const stats = await this.#stat(path).catch((error: unknown) => {
      if (error instanceof RemoteMissingError) return null;
      throw error;
    });
    if (!stats) return null;
    return stats.isDirectory() ? "folder" : "file";
  }

  /** A file's bytes on their way out, for a download or a preview. */
  async read(path: string): Promise<{ stream: Readable; size: number }> {
    const stats = await this.#stat(path);
    if (stats.isDirectory()) throw new RemotePathError(`${path} is a folder`);
    return { stream: this.#sftp.createReadStream(path), size: stats.size };
  }

  /** A text file for the editor, with the version a save must name. */
  async readText(path: string): Promise<{ content: string; version: string }> {
    const stats = await this.#stat(path);
    if (stats.isDirectory()) throw new RemotePathError(`${path} is a folder`);
    if (stats.size > MAX_REMOTE_READ_BYTES) throw new RemoteTooLargeError(`${remoteBasename(path)} is too large to open here`);
    const buffer = await this.#readAll(path);
    if (buffer.subarray(0, 8000).includes(0)) throw new RemoteBinaryError(`${remoteBasename(path)} is not a text file`);
    return { content: buffer.toString("utf8"), version: contentVersion(buffer) };
  }

  /**
   * Saves a text file. With `ifVersion`, refuses when what is there now is
   * not what the editor opened -- someone changed it in a shell meanwhile.
   */
  async writeText(path: string, content: string, ifVersion?: string): Promise<{ version: string }> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_REMOTE_WRITE_BYTES) throw new RemoteTooLargeError("the file is too large to save from here");
    if (ifVersion !== undefined) {
      const current = await this.#readAll(path).catch((error: unknown) => {
        if (error instanceof RemoteMissingError) return null;
        throw error;
      });
      const version = current ? contentVersion(current) : null;
      if (version !== ifVersion) {
        const text = current && !current.subarray(0, 8000).includes(0) ? current.toString("utf8") : null;
        throw new RemoteStaleError(text, version);
      }
    }
    await call<void>(path, (done) => this.#sftp.writeFile(path, bytes, done));
    return { version: contentVersion(bytes) };
  }

  /** An upload. Refuses to replace a file unless `overwrite`. */
  async write(path: string, body: Buffer, overwrite = false): Promise<void> {
    const existing = await this.kind(path);
    if (existing === "folder") throw new RemoteConflictError(`${path} is a folder`);
    if (existing === "file" && !overwrite) throw new RemoteConflictError(`${remoteBasename(path)} already exists`);
    await call<void>(path, (done) => this.#sftp.writeFile(path, body, done));
  }

  async mkdir(path: string): Promise<void> {
    if (await this.kind(path)) throw new RemoteConflictError(`${remoteBasename(path)} already exists`);
    await call<void>(path, (done) => this.#sftp.mkdir(path, done));
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    if (!(await this.kind(from))) throw new RemoteMissingError(`${from} does not exist`);
    if (await this.kind(to)) throw new RemoteConflictError(`${remoteBasename(to)} already exists`);
    await call<void>(from, (done) => this.#sftp.rename(from, to, done));
  }

  /** Removes a file, or a folder and everything in it. False when nothing was there. */
  async remove(path: string): Promise<boolean> {
    if (path === "/" || path === this.home) throw new RemotePathError("refusing to delete the root or the home folder");
    const stats = await this.#lstat(path).catch((error: unknown) => {
      if (error instanceof RemoteMissingError) return null;
      throw error;
    });
    if (!stats) return false;
    if (!stats.isDirectory()) {
      await call<void>(path, (done) => this.#sftp.unlink(path, done));
      return true;
    }
    await this.#removeTree(path, { left: MAX_REMOVE_ENTRIES });
    return true;
  }

  async #removeTree(dir: string, budget: { left: number }): Promise<void> {
    const rows = await call<FileEntryWithStats[]>(dir, (done) => this.#sftp.readdir(dir, done));
    for (const row of rows) {
      if (--budget.left < 0) throw new RemoteRefusedError("that folder is too large to delete from here; use the terminal");
      const path = remoteJoin(dir, row.filename);
      // A link is removed, never followed: deleting through one would empty its target.
      if ((row.attrs as Stats).isDirectory()) await this.#removeTree(path, budget);
      else await call<void>(path, (done) => this.#sftp.unlink(path, done));
    }
    await call<void>(dir, (done) => this.#sftp.rmdir(dir, done));
  }

  #stat(path: string): Promise<Stats> {
    return call<Stats>(path, (done) => this.#sftp.stat(path, done));
  }

  #lstat(path: string): Promise<Stats> {
    return call<Stats>(path, (done) => this.#sftp.lstat(path, done));
  }

  #readAll(path: string): Promise<Buffer> {
    return call<Buffer>(path, (done) => this.#sftp.readFile(path, done));
  }
}
