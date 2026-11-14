import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { and, asc, eq } from "drizzle-orm";
import { assertRealpathInside } from "@ucch/agent";
import { resourceStores, type Database, type ResourceStoreRow } from "@ucch/db";
import {
  WORKSPACE_STORE_ID,
  normalizeResourceKey,
  type ResourceEntry,
  type ResourceStoreSummary,
  type S3StoreCreate,
  type S3StoreUpdate,
} from "@ucch/protocol";
import { decryptSecret, encryptSecret } from "./crypto.js";

/** A key that is malformed or reaches outside the store. Reported as 400. */
export class ResourceKeyError extends Error {}
/** The key is already taken. Reported as 409. */
export class ResourceConflictError extends Error {}
/** The store could not be reached or refused the request. Reported as 502. */
export class ResourceStoreError extends Error {}

/** A file's bytes on their way out. */
export interface ResourceRead {
  stream: Readable;
  size: number;
}

/**
 * One place a workspace keeps Resources. Keys are `normalizeResourceKey`'s:
 * relative, `/`-separated, "" for the root (folders only).
 */
export interface ResourceBackend {
  /** One level of a folder, folders first, then by name. */
  list(prefix: string): Promise<ResourceEntry[]>;
  /** What is at a key: a file, a folder, or nothing. */
  kindOf(key: string): Promise<"file" | "folder" | null>;
  read(key: string): Promise<ResourceRead | null>;
  /** Writes a file. Refuses to replace one unless `overwrite`. */
  write(key: string, body: Buffer, type: string, overwrite?: boolean): Promise<void>;
  mkdir(key: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Removes a file, or a folder and everything under it. False when nothing was there. */
  remove(key: string): Promise<boolean>;
  /** Every file under a folder, as keys relative to the store, for copying a folder out. */
  walk(prefix: string, limit: number): Promise<{ key: string; size: number }[]>;
}

/** A caller's key, normalised, or a `ResourceKeyError`. `allowRoot` for folders. */
export function keyOf(key: string, allowRoot = false): string {
  const normalized = normalizeResourceKey(key);
  if (normalized === null) throw new ResourceKeyError(`not a valid path: ${key}`);
  if (normalized === "" && !allowRoot) throw new ResourceKeyError("a file name is required");
  return normalized;
}

function byFoldersThenName(a: ResourceEntry, b: ResourceEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * The workspace's own storage: `WORKSPACE_ROOT/.resources/{workspaceId}/`.
 *
 * A sibling of the project directories and of `.uploads`, never inside one
 * -- the same placement argument as `UploadStore`: a workspace id is a UUID
 * so it cannot collide with a project, and nothing confined to a project's
 * directory (the agent's tools, the file panel) can see in. A file reaches a
 * project only when someone copies it there.
 */
export class LocalBackend implements ResourceBackend {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** The absolute path for a key, confined to the root lexically and through symlinks. */
  async #path(key: string): Promise<string> {
    const absolute = key === "" ? this.#root : resolve(this.#root, ...key.split("/"));
    if (absolute !== this.#root && !absolute.startsWith(this.#root + sep)) {
      throw new ResourceKeyError("path escapes the store");
    }
    await assertRealpathInside(this.#root, absolute, () => new ResourceKeyError("path escapes the store"));
    return absolute;
  }

  async list(prefix: string): Promise<ResourceEntry[]> {
    await mkdir(this.#root, { recursive: true });
    const dir = await this.#path(prefix);
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: ResourceEntry[] = [];
    for (const d of names) {
      // Links are never followed, so they are not listed either.
      if (!d.isFile() && !d.isDirectory()) continue;
      const key = join(prefix, d.name);
      if (d.isDirectory()) {
        entries.push({ key, name: d.name, kind: "folder" });
      } else {
        const info = await stat(resolve(dir, d.name)).catch(() => null);
        if (!info) continue;
        entries.push({ key, name: d.name, kind: "file", size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
    return entries.sort(byFoldersThenName);
  }

  async kindOf(key: string): Promise<"file" | "folder" | null> {
    const info = await lstat(await this.#path(key)).catch(() => null);
    if (!info) return null;
    return info.isDirectory() ? "folder" : info.isFile() ? "file" : null;
  }

  async read(key: string): Promise<ResourceRead | null> {
    const path = await this.#path(key);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) return null;
    return { stream: createReadStream(path), size: info.size };
  }

  async write(key: string, body: Buffer, _type: string, overwrite = false): Promise<void> {
    const path = await this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Checked again after the parents exist: one of them may be a link.
    await this.#path(key);
    try {
      await writeFile(path, body, { flag: overwrite ? "w" : "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ResourceConflictError(`${key} already exists`);
      throw error;
    }
  }

  async mkdir(key: string): Promise<void> {
    const path = await this.#path(key);
    if (await lstat(path).then(() => true, () => false)) throw new ResourceConflictError(`${key} already exists`);
    await mkdir(path, { recursive: true });
  }

  async move(from: string, to: string): Promise<void> {
    if (to === from || to.startsWith(`${from}/`)) throw new ResourceKeyError(`${from} cannot be moved into itself`);
    const source = await this.#path(from);
    const destination = await this.#path(to);
    if (!(await lstat(source).then(() => true, () => false))) throw new ResourceKeyError(`${from} is not there`);
    if (await lstat(destination).then(() => true, () => false)) throw new ResourceConflictError(`${to} already exists`);
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }

  async remove(key: string): Promise<boolean> {
    if (key === "") throw new ResourceKeyError("the store itself cannot be deleted");
    const path = await this.#path(key);
    if (!(await lstat(path).then(() => true, () => false))) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  }

  async walk(prefix: string, limit: number): Promise<{ key: string; size: number }[]> {
    const found: { key: string; size: number }[] = [];
    const queue = [prefix];
    while (queue.length > 0) {
      const folder = queue.shift()!;
      for (const entry of await this.list(folder)) {
        if (entry.kind === "folder") queue.push(entry.key);
        else found.push({ key: entry.key, size: entry.size ?? 0 });
        if (found.length > limit) return found;
      }
    }
    return found;
  }
}

export interface S3Config {
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * A bucket, or a folder inside one. A folder is a key prefix; an empty one
 * is kept visible by a zero-byte `name/` placeholder, which is what the S3
 * consoles create too. Moving is copy-then-delete: S3 has no rename.
 */
export class S3Backend implements ResourceBackend {
  readonly #client: S3Client;
  readonly #bucket: string;
  /** The bucket-level prefix every key sits under, "" or ending in `/`. */
  readonly #base: string;

  constructor(config: S3Config, client?: S3Client) {
    this.#client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint || undefined,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      });
    this.#bucket = config.bucket;
    const base = normalizeResourceKey(config.prefix) ?? "";
    this.#base = base ? `${base}/` : "";
  }

  #full(key: string): string {
    return this.#base + key;
  }

  async #send<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ResourceKeyError || error instanceof ResourceConflictError) throw error;
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") throw error;
      throw new ResourceStoreError(error instanceof Error ? error.message : String(error));
    }
  }

  async list(prefix: string): Promise<ResourceEntry[]> {
    const folder = prefix ? `${this.#full(prefix)}/` : this.#base;
    const entries: ResourceEntry[] = [];
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.#send(() =>
        this.#client.send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: folder, Delimiter: "/", ContinuationToken: token }),
        ),
      );
      for (const p of page.CommonPrefixes ?? []) {
        const name = p.Prefix!.slice(folder.length).replace(/\/$/, "");
        if (name) entries.push({ key: join(prefix, name), name, kind: "folder" });
      }
      for (const o of page.Contents ?? []) {
        const name = o.Key!.slice(folder.length);
        // The folder's own placeholder, and anything a key-normaliser would refuse.
        if (!name || name.includes("/")) continue;
        entries.push({
          key: join(prefix, name),
          name,
          kind: "file",
          size: o.Size ?? 0,
          modifiedAt: o.LastModified?.toISOString(),
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token && entries.length < 5000);
    return entries.sort(byFoldersThenName);
  }

  async kindOf(key: string): Promise<"file" | "folder" | null> {
    if (key === "") return "folder";
    const head = await this.#client
      .send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#full(key) }))
      .then(() => true, () => false);
    if (head) return "file";
    const page = await this.#send(() =>
      this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: `${this.#full(key)}/`, MaxKeys: 1 })),
    );
    return (page.KeyCount ?? page.Contents?.length ?? 0) > 0 ? "folder" : null;
  }

  async read(key: string): Promise<ResourceRead | null> {
    try {
      const object = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: this.#full(key) }));
      if (!object.Body) return null;
      return { stream: object.Body as Readable, size: object.ContentLength ?? 0 };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw new ResourceStoreError(error instanceof Error ? error.message : String(error));
    }
  }

  async write(key: string, body: Buffer, type: string, overwrite = false): Promise<void> {
    if (!overwrite && (await this.kindOf(key))) throw new ResourceConflictError(`${key} already exists`);
    await this.#send(() =>
      this.#client.send(
        new PutObjectCommand({ Bucket: this.#bucket, Key: this.#full(key), Body: body, ContentType: type }),
      ),
    );
  }

  async mkdir(key: string): Promise<void> {
    if (await this.kindOf(key)) throw new ResourceConflictError(`${key} already exists`);
    await this.#send(() =>
      this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: `${this.#full(key)}/`, Body: "" })),
    );
  }

  /** Every object at or under a key: the file itself, or a folder's whole contents and placeholder. */
  async #objectsUnder(key: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.#send(() =>
        this.#client.send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: `${this.#full(key)}/`, ContinuationToken: token }),
        ),
      );
      for (const o of page.Contents ?? []) keys.push(o.Key!);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async move(from: string, to: string): Promise<void> {
    if (to === from || to.startsWith(`${from}/`)) throw new ResourceKeyError(`${from} cannot be moved into itself`);
    const kind = await this.kindOf(from);
    if (!kind) throw new ResourceKeyError(`${from} is not there`);
    if (await this.kindOf(to)) throw new ResourceConflictError(`${to} already exists`);
    const sources = kind === "file" ? [this.#full(from)] : await this.#objectsUnder(from);
    const fromFull = this.#full(from);
    const toFull = this.#full(to);
    for (const source of sources) {
      const target = toFull + source.slice(fromFull.length);
      await this.#send(() =>
        this.#client.send(
          new CopyObjectCommand({
            Bucket: this.#bucket,
            Key: target,
            CopySource: `${this.#bucket}/${source.split("/").map(encodeURIComponent).join("/")}`,
          }),
        ),
      );
    }
    await this.#deleteKeys(sources);
  }

  async #deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.#send(() =>
        this.#client.send(
          new DeleteObjectsCommand({ Bucket: this.#bucket, Delete: { Objects: batch.map((Key) => ({ Key })) } }),
        ),
      );
    }
  }

  async remove(key: string): Promise<boolean> {
    if (key === "") throw new ResourceKeyError("the store itself cannot be deleted");
    const kind = await this.kindOf(key);
    if (!kind) return false;
    await this.#deleteKeys(kind === "file" ? [this.#full(key)] : await this.#objectsUnder(key));
    return true;
  }

  async walk(prefix: string, limit: number): Promise<{ key: string; size: number }[]> {
    const folder = prefix ? `${this.#full(prefix)}/` : this.#base;
    const found: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.#send(() =>
        this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: folder, ContinuationToken: token })),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key!.endsWith("/")) continue;
        found.push({ key: o.Key!.slice(this.#base.length), size: o.Size ?? 0 });
        if (found.length > limit) return found;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  /** One cheap call that proves the credentials and bucket work. */
  async probe(): Promise<void> {
    await this.#send(() =>
      this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: this.#base, MaxKeys: 1 })),
    );
  }
}

const WORKSPACE_STORE_NAME = "Workspace storage";

function summarize(row: ResourceStoreRow): ResourceStoreSummary {
  return {
    id: row.id,
    kind: "s3",
    name: row.name,
    s3: {
      endpoint: row.config.endpoint,
      region: row.config.region,
      bucket: row.config.bucket,
      prefix: row.config.prefix,
      forcePathStyle: row.config.forcePathStyle,
      accessKeyId: row.config.accessKeyId,
    },
  };
}

/** The stored config and secret a create or update would produce, ready to probe. */
export function s3ConfigOf(input: S3StoreCreate): S3Config {
  return {
    endpoint: input.endpoint || null,
    region: input.region,
    bucket: input.bucket,
    prefix: normalizeResourceKey(input.prefix ?? "") ?? "",
    forcePathStyle: input.forcePathStyle,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  };
}

/**
 * A workspace's Resources stores: its own disk storage, always first and
 * never stored, then the S3 buckets it has added.
 */
export class ResourceStoreService {
  constructor(
    private readonly db: Database,
    private readonly workspaceRoot: string,
    private readonly secretKey: string | undefined,
    /** Swappable for tests. */
    private readonly makeS3: (config: S3Config) => S3Backend = (config) => new S3Backend(config),
  ) {}

  /** Where a workspace's own storage lives on disk. */
  localRoot(workspaceId: string): string {
    return resolve(this.workspaceRoot, ".resources", workspaceId);
  }

  async list(workspaceId: string): Promise<ResourceStoreSummary[]> {
    const rows = await this.db
      .select()
      .from(resourceStores)
      .where(eq(resourceStores.workspaceId, workspaceId))
      .orderBy(asc(resourceStores.createdAt));
    return [{ id: WORKSPACE_STORE_ID, kind: "local", name: WORKSPACE_STORE_NAME }, ...rows.map(summarize)];
  }

  async #row(workspaceId: string, storeId: string): Promise<ResourceStoreRow | null> {
    // A malformed id would be a database error rather than "not found".
    if (!/^[0-9a-f-]{36}$/i.test(storeId)) return null;
    const [row] = await this.db
      .select()
      .from(resourceStores)
      .where(and(eq(resourceStores.id, storeId), eq(resourceStores.workspaceId, workspaceId)))
      .limit(1);
    return row ?? null;
  }

  /** The backend for a store of this workspace, or null when there is no such store. */
  async backend(workspaceId: string, storeId: string): Promise<ResourceBackend | null> {
    if (storeId === WORKSPACE_STORE_ID) return new LocalBackend(this.localRoot(workspaceId));
    const row = await this.#row(workspaceId, storeId);
    if (!row || !this.secretKey) return null;
    return this.makeS3({ ...row.config, secretAccessKey: decryptSecret(row.secretEncrypted, this.secretKey) });
  }

  /** Probes the bucket first: a store that cannot be listed is a typo, not a record. */
  async create(workspaceId: string, userId: string, input: S3StoreCreate, secretKey: string): Promise<ResourceStoreSummary> {
    const config = s3ConfigOf(input);
    await this.makeS3(config).probe();
    const { secretAccessKey, ...stored } = config;
    const [row] = await this.db
      .insert(resourceStores)
      .values({
        workspaceId,
        kind: "s3",
        name: input.name,
        config: stored,
        secretEncrypted: encryptSecret(secretAccessKey, secretKey),
        createdBy: userId,
      })
      .returning();
    return summarize(row!);
  }

  async update(
    workspaceId: string,
    storeId: string,
    input: S3StoreUpdate,
    secretKey: string,
  ): Promise<ResourceStoreSummary | null> {
    const row = await this.#row(workspaceId, storeId);
    if (!row) return null;
    const merged = s3ConfigOf({
      name: input.name ?? row.name,
      endpoint: input.endpoint ?? row.config.endpoint ?? "",
      region: input.region ?? row.config.region,
      bucket: input.bucket ?? row.config.bucket,
      prefix: input.prefix ?? row.config.prefix,
      forcePathStyle: input.forcePathStyle ?? row.config.forcePathStyle,
      accessKeyId: input.accessKeyId ?? row.config.accessKeyId,
      secretAccessKey: input.secretAccessKey ?? decryptSecret(row.secretEncrypted, secretKey),
    });
    await this.makeS3(merged).probe();
    const { secretAccessKey, ...stored } = merged;
    const [updated] = await this.db
      .update(resourceStores)
      .set({ name: input.name ?? row.name, config: stored, secretEncrypted: encryptSecret(secretAccessKey, secretKey) })
      .where(eq(resourceStores.id, row.id))
      .returning();
    return summarize(updated!);
  }

  /** Forgets the store. The bucket and its files are left alone. */
  async remove(workspaceId: string, storeId: string): Promise<boolean> {
    const row = await this.#row(workspaceId, storeId);
    if (!row) return false;
    await this.db.delete(resourceStores).where(eq(resourceStores.id, row.id));
    return true;
  }
}

/** The last segment of a key: the name a copy is given. */
export { lastSegment as resourceName };

/** Collects a stream into one buffer, refusing anything past `maxBytes`. */
export async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new ResourceKeyError("the file is too large to copy");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

