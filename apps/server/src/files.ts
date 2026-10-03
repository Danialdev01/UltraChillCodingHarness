import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { normalizeWorkspacePath } from "@ucch/protocol";

/**
 * The project's files, as the browser is allowed to see them.
 *
 * The same workspace directory the agent's `HostExecutor` runs in, reached
 * from the other side: the person editing in the browser and the model
 * editing through a tool are both confined to `WORKSPACE_ROOT/{projectId}`,
 * by the same normalisation, so neither can reach a path the other could not.
 *
 * Nothing here trusts the caller's path. `resolve()` is the only way in, and
 * every method goes through it.
 */

/** A directory is `{ name, children }`; a file is `{ name }`. */
export interface FileNode {
  name: string;
  children?: FileNode[];
}

/** Never listed. A checkout's `.git` alone is thousands of entries. */
const HIDDEN = new Set([".git"]);

/**
 * Listed as an empty folder rather than walked.
 *
 * These are large, machine-generated, and not what anyone opened a file tree
 * to read. They stay visible -- a missing `node_modules` reads as a broken
 * install -- but their contents are not worth the walk or the payload.
 */
const UNWALKED = new Set(["node_modules", ".next", "dist", "build", "vendor", ".venv", "target"]);

/** Entries walked before the tree stops growing. */
const MAX_ENTRIES = 5_000;

/** Bytes served for one file. Past this the editor would not cope either. */
const MAX_READ_BYTES = 1024 * 1024;

/** Bytes accepted for one file. */
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Bytes served for one previewed image or PDF.
 *
 * Larger than the editor's own cap because a photograph legitimately is: the
 * text limit exists so a bundle does not reach CodeMirror, and this one so a
 * video someone renamed does not reach the browser whole.
 */
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

export type RawReadResult =
  | { kind: "file"; bytes: Buffer }
  | { kind: "too_large"; size: number }
  | { kind: "missing" }
  | { kind: "directory" };

export type ReadResult =
  /** `version` names these exact bytes, for a save that must not overwrite another. */
  | { kind: "text"; content: string; version: string }
  | { kind: "binary" }
  | { kind: "too_large"; size: number }
  | { kind: "missing" }
  | { kind: "directory" };

export class WorkspaceFiles {
  constructor(private readonly workspaceRoot: string) {}

  /** The project's own directory, created if a clone has not made it yet. */
  async ensureRoot(projectId: string): Promise<string> {
    const root = this.root(projectId);
    await mkdir(root, { recursive: true });
    return root;
  }

  root(projectId: string): string {
    return resolve(this.workspaceRoot, projectId);
  }

  /**
   * A caller's path, as an absolute one inside the project.
   *
   * Absolute input is refused rather than reinterpreted, `..` cannot climb
   * out, and the result is checked against the root a second time -- the
   * normalisation has already refused traversal, and this refuses anything
   * that got past it however it managed to.
   *
   * The check is lexical, so a symlink inside the tree pointing out of it
   * still resolves outward when the filesystem follows it. `realpath` is
   * applied by the methods that touch an existing file, which is where a
   * symlink can actually be followed.
   */
  resolve(projectId: string, path: string): string {
    if (isAbsolute(path)) throw new PathError(`path must be relative: ${path}`);
    const normalized = normalizeWorkspacePath(path);
    if (normalized === null) throw new PathError(`path escapes the workspace: ${path}`);

    const root = this.root(projectId);
    const absolute = resolve(root, normalized);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new PathError(`path escapes the workspace: ${path}`);
    }
    return absolute;
  }

  /** The whole tree, folders first, capped so one enormous repository cannot hang the panel. */
  async tree(projectId: string): Promise<{ tree: FileNode[]; truncated: boolean }> {
    const root = await this.ensureRoot(projectId);
    const budget = { left: MAX_ENTRIES };
    const tree = await walk(root, budget);
    return { tree, truncated: budget.left <= 0 };
  }

  async read(projectId: string, path: string): Promise<ReadResult> {
    const absolute = this.resolve(projectId, path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      return { kind: "missing" };
    }
    if (info.isDirectory()) return { kind: "directory" };
    if (info.size > MAX_READ_BYTES) return { kind: "too_large", size: info.size };
    await this.#refuseEscapingSymlink(projectId, absolute);

    const buffer = await readFile(absolute);
    // A NUL byte in the first block is the practical test for "this is not
    // text": handing an image to a text editor produces mojibake going in and
    // a corrupted file coming out.
    if (buffer.subarray(0, 8000).includes(0)) return { kind: "binary" };
    return { kind: "text", content: buffer.toString("utf8"), version: contentVersion(buffer) };
  }

  /**
   * A file's bytes, unchanged, for the image and PDF preview.
   *
   * Deliberately separate from `read`, which decides text-or-binary by
   * looking for a NUL byte and hands back a string. That decision is right
   * for an editor and wrong here: the whole point is to serve the bytes as
   * they are. Everything else is the same -- the path is resolved through
   * the workspace rules and a symlink out of the tree is refused -- so this
   * can reach no file the editor could not.
   */
  async readBytes(projectId: string, path: string): Promise<RawReadResult> {
    const absolute = this.resolve(projectId, path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      return { kind: "missing" };
    }
    if (info.isDirectory()) return { kind: "directory" };
    if (info.size > MAX_PREVIEW_BYTES) return { kind: "too_large", size: info.size };
    await this.#refuseEscapingSymlink(projectId, absolute);

    return { kind: "file", bytes: await readFile(absolute) };
  }

  /**
   * Creates or overwrites a file. Returns what happened, for the event.
   *
   * With `ifVersion`, only over the exact bytes that version names: a file
   * saved, rewritten by the agent, or deleted since the editor opened it is
   * a `StaleWriteError` carrying what is there now, never a silent
   * overwrite. Writes to one path are taken one at a time so two saves
   * cannot both pass the check.
   */
  async write(
    projectId: string,
    path: string,
    content: string,
    ifVersion?: string,
  ): Promise<"added" | "modified"> {
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new PathError("file is too large to save");
    }
    const absolute = this.resolve(projectId, path);
    return this.#serially(absolute, async () => {
      const existed = await exists(absolute);
      if (existed) await this.#refuseEscapingSymlink(projectId, absolute);
      if (ifVersion !== undefined) {
        const current = existed ? await readFile(absolute) : null;
        if (!current || contentVersion(current) !== ifVersion) {
          throw new StaleWriteError(
            current ? current.toString("utf8") : null,
            current ? contentVersion(current) : null,
          );
        }
      }
      return this.#writeFile(absolute, existed, content);
    });
  }

  #locks = new Map<string, Promise<unknown>>();

  async #serially<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve();
    const next = before.catch(() => {}).then(run);
    this.#locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#locks.get(key) === next) this.#locks.delete(key);
    }
  }

  async #writeFile(absolute: string, existed: boolean, content: string): Promise<"added" | "modified"> {
    // A file saved into a folder that is not there yet means to create it,
    // the same way the agent's `write_file` tool does.
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    return existed ? "modified" : "added";
  }

  /** Creates an empty file or a directory. Refuses to clobber either. */
  async create(projectId: string, path: string, kind: "file" | "directory"): Promise<void> {
    const absolute = this.resolve(projectId, path);
    if (await exists(absolute)) throw new ConflictError(`${path} already exists`);

    if (kind === "directory") {
      await mkdir(absolute, { recursive: true });
      return;
    }
    await mkdir(dirname(absolute), { recursive: true });
    // `wx` rather than a plain write: two tabs creating the same file at once
    // should produce one file and one error, not a silent overwrite.
    await writeFile(absolute, "", { encoding: "utf8", flag: "wx" });
  }

  /** Removes a file, or a directory and everything under it. */
  async remove(projectId: string, path: string): Promise<boolean> {
    const absolute = this.resolve(projectId, path);
    // The project root itself is not a thing the file tree may delete: that
    // is what deleting the project is for.
    if (absolute === this.root(projectId)) throw new PathError("the project root cannot be deleted");
    if (!(await exists(absolute))) return false;

    await this.#refuseEscapingSymlink(projectId, absolute);
    await rm(absolute, { recursive: true, force: true });
    return true;
  }

  /**
   * Moves a file or directory, keeping its contents. Reports a source that
   * was not there, and refuses to clobber whatever is at the destination.
   */
  async move(projectId: string, from: string, to: string): Promise<boolean> {
    const source = this.resolve(projectId, from);
    const destination = this.resolve(projectId, to);
    if (source === this.root(projectId)) throw new PathError("the project root cannot be moved");
    // A directory cannot end up inside itself: `rename` would refuse, but
    // with an error that says nothing about why.
    if (destination === source || destination.startsWith(source + sep)) {
      throw new PathError(`${from} cannot be moved into itself`);
    }
    if (!(await exists(source))) return false;

    await this.#refuseEscapingSymlink(projectId, source);
    if (await exists(destination)) throw new ConflictError(`${to} already exists`);

    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    return true;
  }

  /**
   * Refuses a path that only *lexically* sits inside the workspace.
   *
   * `resolve()` cannot see a symlink; this can, because the file is there to
   * be resolved. A link planted by the agent -- or by a repository that was
   * cloned with one -- must not become a way to read or overwrite the host's
   * files through the editor.
   */
  async #refuseEscapingSymlink(projectId: string, absolute: string): Promise<void> {
    const root = this.root(projectId);
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(absolute);
      realRoot = await realpath(root);
    } catch {
      return; // Not there any more; the caller's own stat will say so.
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new PathError("path escapes the workspace");
    }
  }
}

/** A refused path. Reported as 400, never as a server error. */
export class PathError extends Error {}

/** The target is already there. Reported as 409. */
export class ConflictError extends Error {}

/** A save made against a version of the file that is no longer there. */
export class StaleWriteError extends Error {
  constructor(
    /** The file as it is now, or null when it has been deleted. */
    readonly content: string | null,
    readonly version: string | null,
  ) {
    super("the file was changed elsewhere");
  }
}

/** Names a file's exact bytes. Not a security boundary: a cheap equality check. */
export function contentVersion(bytes: Buffer | string): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

async function walk(dir: string, budget: { left: number }): Promise<FileNode[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries.sort(byFolderThenName)) {
    if (budget.left <= 0) break;
    if (HIDDEN.has(entry.name)) continue;
    budget.left--;

    // A symlink is listed as a file whatever it points at, and never walked:
    // following one out of the tree is exactly what must not happen, and a
    // cycle inside it would not terminate.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      nodes.push({
        name: entry.name,
        children: UNWALKED.has(entry.name) ? [] : await walk(join(dir, entry.name), budget),
      });
    } else {
      nodes.push({ name: entry.name });
    }
  }
  return nodes;
}

function byFolderThenName(a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
