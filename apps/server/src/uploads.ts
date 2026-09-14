import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  UnknownUploadError,
  UploadConflictError,
  type AttachedUpload,
  type StagedUpload,
  type UploadStaging,
} from "@ucch/agent";
import { PathError, type WorkspaceFiles } from "./files.js";

/**
 * Where attachments live before they are part of a project.
 *
 * Staging is a sibling of the project directories, never a child of one:
 * `WORKSPACE_ROOT/.uploads/{projectId}/` against `WORKSPACE_ROOT/{projectId}/`.
 * That placement is the whole security argument. A project id is a UUID, so
 * `.uploads` can never collide with one, and because staging sits outside
 * every workspace root, neither `HostExecutor.resolve` nor `WorkspaceFiles`
 * can reach it -- the agent's `bash`, the file tools, and the browser's file
 * panel are all confined to `WORKSPACE_ROOT/{projectId}`, and none of them
 * can see a staged file until something moves it in on purpose.
 *
 * Each upload is two files: the bytes as `{id}` and the metadata as
 * `{id}.json`. The uploader's filename is therefore never used as a path on
 * the way in -- it is data inside the JSON, so a name like `../../etc/passwd`
 * or a 4 KB unicode monster is a string in a field rather than something the
 * filesystem has to be defended from. It only becomes a path when someone
 * attaches it, and that path goes through `WorkspaceFiles.resolve` like
 * every other write.
 */
export class UploadStore implements UploadStaging {
  readonly #root: string;

  constructor(
    workspaceRoot: string,
    private readonly files: WorkspaceFiles,
    private readonly limits: { maxBytes: number; ttlMs: number },
  ) {
    this.#root = resolve(workspaceRoot, ".uploads");
  }

  /**
   * Sweeps expired staging on an interval.
   *
   * `unref` so it never holds the process open, matching the session
   * sweeper. Returns the timer so a test can stop it.
   */
  startSweeper(everyMs = 15 * 60_000, onError: (e: unknown) => void = () => {}): NodeJS.Timeout {
    const timer = setInterval(() => void this.sweep().catch(onError), everyMs);
    timer.unref();
    return timer;
  }

  /** Accepts bytes into staging and returns what the composer should show. */
  async stage(
    projectId: string,
    name: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<StagedUpload> {
    if (bytes.length === 0) throw new PathError("the file is empty");
    if (bytes.length > this.limits.maxBytes) {
      throw new PathError(
        `the file is larger than the ${Math.round(this.limits.maxBytes / (1024 * 1024))} MB upload limit`,
      );
    }

    const directory = this.#directory(projectId);
    await mkdir(directory, { recursive: true });

    const upload: StagedUpload = {
      id: randomUUID(),
      // Trimmed to the last segment and bounded, because this is what a
      // default destination path is later built from. Not trusted as a path
      // even so -- `attach` resolves whatever it is given through the
      // workspace's own rules.
      name: safeName(name),
      size: bytes.length,
      contentType: contentType.slice(0, 255) || "application/octet-stream",
      stagedAt: new Date().toISOString(),
    };

    await writeFile(resolve(directory, upload.id), bytes);
    await writeFile(resolve(directory, `${upload.id}.json`), JSON.stringify(upload), "utf8");
    return upload;
  }

  async list(projectId: string): Promise<StagedUpload[]> {
    const directory = this.#directory(projectId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return []; // Nothing staged for this project, which is the usual case.
    }

    const uploads: StagedUpload[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const upload = await this.#read(directory, entry.slice(0, -".json".length));
      if (upload) uploads.push(upload);
    }
    // By time, then by id: `readdir` order is the filesystem's business, and
    // two files picked in one gesture share a millisecond, so the timestamp
    // alone leaves their order to whatever the directory happens to return.
    // Arbitrary but deterministic beats different on every call.
    return uploads.sort(
      (a, b) => a.stagedAt.localeCompare(b.stagedAt) || a.id.localeCompare(b.id),
    );
  }

  async find(projectId: string, uploadId: string): Promise<StagedUpload | null> {
    if (!isId(uploadId)) return null;
    return this.#read(this.#directory(projectId), uploadId);
  }

  /**
   * Moves a staged file into the project workspace.
   *
   * `rename` first because it is atomic and does not copy the bytes; it fails
   * with EXDEV when staging and the workspace are on different filesystems,
   * which is ordinary in a container where one is a bind mount, so the copy
   * is a fallback rather than an error path.
   *
   * The metadata is removed last. If the process dies between the two, the
   * file is in the workspace and staging holds a record pointing at bytes
   * that are gone -- `#read` treats that as expired and drops it, which is
   * the harmless direction to fail in. The other order would lose the file.
   */
  async attach(projectId: string, uploadId: string, path: string): Promise<AttachedUpload> {
    const upload = await this.find(projectId, uploadId);
    if (!upload) throw new UnknownUploadError(`no staged upload ${uploadId}`);

    const directory = this.#directory(projectId);
    const source = resolve(directory, upload.id);

    // Through the same resolver the editor and the agent's tools use, so an
    // attachment cannot be placed anywhere they could not have written. A
    // PathError from here reaches the route as a 400 and the model as a
    // message it can correct.
    const destination = this.files.resolve(projectId, path || upload.name);
    if (destination === this.files.root(projectId)) {
      throw new PathError("a destination filename is required");
    }
    if (await exists(destination)) {
      throw new UploadConflictError(`${path} already exists`);
    }

    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(source, destination);
      await unlink(source);
    }
    await rm(resolve(directory, `${upload.id}.json`), { force: true });

    const relative = destination.slice(this.files.root(projectId).length + 1);
    return { path: relative, size: upload.size };
  }

  /**
   * Keeps a staged file past its time to live.
   *
   * An image the model was shown is no longer working memory: it is part of
   * what the conversation said, and replaying the thread a week later has to
   * be able to show the same picture. Sweeping it would leave a turn that
   * cannot be reconstructed -- so the reference outlives the window.
   *
   * Idempotent, and quiet about an id it cannot find: this runs on every turn
   * over the whole history, and an upload that was attached into the
   * workspace and its record removed is not an error to report.
   */
  async retain(projectId: string, uploadId: string): Promise<void> {
    const directory = this.#directory(projectId);
    const upload = await this.#read(directory, uploadId);
    if (!upload || upload.retained) return;
    await writeFile(
      resolve(directory, `${uploadId}.json`),
      JSON.stringify({ ...upload, retained: true }),
      "utf8",
    );
  }

  /**
   * A staged file's bytes, or null when there are none to read.
   *
   * Null rather than a throw, because every caller is rendering a
   * conversation: an image that has been swept, or attached into the
   * workspace and its staging record removed, is a gap to describe rather
   * than a turn to fail.
   */
  async readBytes(
    projectId: string,
    uploadId: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    const directory = this.#directory(projectId);
    const upload = await this.#read(directory, uploadId);
    if (!upload) return null;
    try {
      return { bytes: await readFile(resolve(directory, uploadId)), contentType: upload.contentType };
    } catch {
      return null;
    }
  }

  /** Forgets a staged file. Used when the composer drops a chip. */
  async discard(projectId: string, uploadId: string): Promise<boolean> {
    if (!isId(uploadId)) return false;
    const directory = this.#directory(projectId);
    if (!(await this.#read(directory, uploadId))) return false;

    await rm(resolve(directory, uploadId), { force: true });
    await rm(resolve(directory, `${uploadId}.json`), { force: true });
    return true;
  }

  /** Everything staged for a project, when the project itself is deleted. */
  async discardAll(projectId: string): Promise<void> {
    await rm(this.#directory(projectId), { recursive: true, force: true });
  }

  /**
   * Drops staging past its time to live.
   *
   * Attachments are working memory, not storage: a file nobody referred to
   * within the window was context for a question that has been answered, and
   * keeping it forever turns a chat box into an unmanaged disk.
   */
  async sweep(now = Date.now()): Promise<number> {
    let projects: string[];
    try {
      projects = await readdir(this.#root);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const projectId of projects) {
      const directory = resolve(this.#root, projectId);
      for (const upload of await this.list(projectId)) {
        // Retained uploads are referenced by a message and are no longer
        // working memory. `discardAll` still takes them when the project goes.
        if (upload.retained) continue;
        if (now - Date.parse(upload.stagedAt) < this.limits.ttlMs) continue;
        await rm(resolve(directory, upload.id), { force: true });
        await rm(resolve(directory, `${upload.id}.json`), { force: true });
        removed++;
      }
    }
    return removed;
  }

  #directory(projectId: string): string {
    if (!isId(projectId)) throw new PathError("invalid project id");
    return resolve(this.#root, projectId);
  }

  /**
   * One upload's metadata, or null if it is not usable.
   *
   * A record whose bytes are missing counts as gone rather than as an error:
   * it is what a half-finished attach or an interrupted write leaves behind,
   * and reporting it would offer the model an id that cannot be placed.
   */
  async #read(directory: string, uploadId: string): Promise<StagedUpload | null> {
    if (!isId(uploadId)) return null;
    try {
      const raw = await readFile(resolve(directory, `${uploadId}.json`), "utf8");
      const parsed = JSON.parse(raw) as StagedUpload;
      if (parsed.id !== uploadId) return null;
      const info = await stat(resolve(directory, uploadId));
      return { ...parsed, size: info.size };
    } catch {
      return null;
    }
  }
}

/**
 * The most of a text attachment the chat's preview will show.
 *
 * The same 256 KB the composer will inline into a message, and for the same
 * reason: past this a file is something to download and open, not something to
 * read in a dialog. The route says when it has cut one, so the dialog can
 * point at the download rather than pretend it showed the whole file.
 */
export const UPLOAD_TEXT_PREVIEW_BYTES = 256 * 1024;

/**
 * A `Content-Disposition` that names a download without trusting the name.
 *
 * Two forms, as RFC 6266 asks for: a plain `filename` stripped to printable
 * ASCII for a client that reads only that one, and `filename*` carrying the
 * real name percent-encoded as UTF-8. Names reaching here have been through
 * `safeName`, which takes out control characters and quotes; this removes what
 * is left that would end the header value early or leave a raw non-ASCII byte
 * in it -- neither of which is valid HTTP, whatever the file was called.
 *
 * It lives beside `safeName` because it is the same question asked at the other
 * end: that one decides what an uploaded name may become, this one decides what
 * may be said about it on the way back out.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * A filename reduced to something that can safely become a path segment.
 *
 * Only ever used to build a *default* destination -- the caller may name any
 * path they like, and that one is checked by the workspace resolver. This
 * keeps the common case ("add this file") from needing one.
 */
export function safeName(name: string): string {
  // Both separators, because a Windows client sends backslashes and the
  // last segment is the filename in either convention.
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // Control characters, and the characters that mean something to a
    // filesystem or a URL. Spaces survive: they are ordinary in a filename,
    // and nothing here builds a shell string out of it.
    .replace(/[\u0000-\u001f\u007f<>:"|?*\\]/g, "")
    // A leading dot would hide the attachment in the file tree, which is
    // not what anyone attaching a file meant.
    .replace(/^\.+/, "")
    .trim();

  if (!cleaned) return "attachment";
  if (cleaned.length <= 120) return cleaned;

  // Truncated from the middle of the stem so the extension survives -- it is
  // what decides how the file is opened.
  const ext = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** UUIDs only: ids come from `randomUUID`, and anything else is a probe. */
function isId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Re-exported so a route can catch every staging failure from one import.
export { PathError, UnknownUploadError, UploadConflictError };
export type { StagedUpload };
