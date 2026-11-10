import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  RUNTIME_DEFAULT_SELECTION,
  RUNTIME_IDS,
  RUNTIME_LABELS,
  RUNTIMES_FILE,
  RuntimesFile,
  type ProjectRuntimeStatus,
  type ProjectRuntimesResponse,
  type RuntimeId,
  type RuntimeInstallProgress,
} from "@ucch/protocol";

import { agentPath, writeIfChanged } from "../agent-sync.js";
import { refreshIndexFiles } from "../dev-database.js";
import { projectIdOfPath, projectRoot } from "../trees.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";
import { compareVersions, newestFirst, parseVersion, pickVersion, satisfiesConstraint } from "./version.js";

/**
 * Per-project runtime versions, installed once per server and shared.
 *
 * On disk, under `RUNTIMES_ROOT`:
 *
 *   php/8.4.12/bin/php            one folder per installed version
 *   projects/{projectId}/bin/php  -> ../../../php/8.4.12/bin/php
 *
 * Every process a project starts -- its terminals, its command buttons, the
 * CLI agents and the native agent's `bash` -- has its `projects/{id}/bin`
 * first on PATH (`pathFor`). Choosing another version re-points the link,
 * atomically, so a terminal already open runs the new one on its next
 * command: nothing restarts, and nothing sits between the shell and the
 * binary. `composer` is `#!/usr/bin/env php`, so it follows.
 *
 * The choice itself is `.agent/runtimes.json` in the project, committed with
 * it; the link is only a cache of what that file resolves to, and is
 * checked again at every spawn, so a `git pull` that changes the file takes
 * effect without anyone pressing anything. A runtime the file does not name
 * is `latest`: the newest version installed. With nothing installed the link
 * is absent and PATH falls through to the system's own `php`.
 */

const AVAILABLE_TTL_MS = 6 * 60 * 60_000;
const AVAILABLE_ERROR_TTL_MS = 5 * 60_000;
/** A selection whose automatic install failed is not tried again for this long. */
const AUTO_RETRY_MS = 10 * 60_000;
const SYSTEM_TTL_MS = 10 * 60_000;
const MAX_FILE_BYTES = 64 * 1024;

export interface RuntimeManagerOptions {
  /** `RUNTIMES_ROOT`. */
  root: string;
  workspaceRoot: string;
  providers: Partial<Record<RuntimeId, RuntimeProvider>>;
  /** Download a version on its own when a project's selection has none installed. */
  autoInstall: boolean;
  /** An install a project waits on started, finished or failed: its pages refetch. */
  changed?(projectId: string): void;
  log?(error: unknown, context: string): void;
}

export interface RuntimeSelections {
  selections: Partial<Record<RuntimeId, string>>;
  /** Why the file could not be used; null when it was fine or absent. */
  error: string | null;
}

export class RuntimeInUseError extends Error {}

interface Install {
  promise: Promise<void>;
  progress: RuntimeInstallProgress;
  waiters: Set<string>;
}

/** `.agent/runtimes.json` of a checkout, read synchronously (a terminal opens synchronously). */
export function readSelections(root: string): RuntimeSelections {
  const path = join(root, RUNTIMES_FILE);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { selections: {}, error: null };
  }
  if (info.isSymbolicLink()) return { selections: {}, error: "runtimes.json is a symlink; it is not read" };
  if (!info.isFile()) return { selections: {}, error: "runtimes.json is not a file" };
  if (info.size > MAX_FILE_BYTES) return { selections: {}, error: "runtimes.json is too large" };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { selections: {}, error: `runtimes.json is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = RuntimesFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { selections: {}, error: `runtimes.json: ${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}` };
  }
  const selections: Partial<Record<RuntimeId, string>> = {};
  for (const id of RUNTIME_IDS) {
    const choice = parsed.data[id];
    if (choice) selections[id] = choice.version;
  }
  return { selections, error: null };
}

/** Writes the selections into `.agent/runtimes.json`, keeping whatever else the file holds. */
export async function writeSelections(root: string, next: Partial<Record<RuntimeId, string>>): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const parsed = RuntimesFile.safeParse(JSON.parse(readFileSync(join(root, RUNTIMES_FILE), "utf8")));
    if (parsed.success) current = parsed.data;
  } catch {
    // Absent or unreadable: written fresh.
  }
  for (const [id, version] of Object.entries(next)) current[id] = { version };
  const file = RuntimesFile.parse(current);
  const path = await agentPath(root, "runtimes.json");
  if (await writeIfChanged(path, `${JSON.stringify(file, null, 2)}\n`)) await refreshIndexFiles(root);
}

export class RuntimeManager {
  readonly #available = new Map<RuntimeId, { at: number; releases?: RuntimeRelease[]; error?: string }>();
  readonly #availableInFlight = new Map<RuntimeId, Promise<RuntimeRelease[]>>();
  readonly #installs = new Map<string, Install>();
  readonly #lastError = new Map<RuntimeId, string>();
  readonly #autoTried = new Map<string, number>();
  readonly #system = new Map<RuntimeId, { at: number; version: Promise<string | null> }>();

  constructor(private readonly options: RuntimeManagerOptions) {}

  get providers(): RuntimeProvider[] {
    return RUNTIME_IDS.map((id) => this.options.providers[id]).filter((p): p is RuntimeProvider => Boolean(p));
  }

  #provider(id: RuntimeId): RuntimeProvider {
    const provider = this.options.providers[id];
    if (!provider) throw new Error(`the ${id} runtime is not available on this server`);
    return provider;
  }

  /** The folder a project's processes have first on PATH. */
  binDir(projectId: string): string {
    return join(this.options.root, "projects", projectId, "bin");
  }

  /** Remove this project's links and stop pending installs from recreating them. */
  async removeProject(projectId: string): Promise<void> {
    for (const install of this.#installs.values()) install.waiters.delete(projectId);
    await rm(join(this.options.root, "projects", projectId), { recursive: true, force: true });
  }

  #versionDir(id: RuntimeId, version: string): string {
    return join(this.options.root, id, version);
  }

  /** Installed versions, newest first: folders whose every binary is there. */
  installed(id: RuntimeId): string[] {
    const provider = this.#provider(id);
    let names: string[];
    try {
      names = readdirSync(join(this.options.root, id));
    } catch {
      return [];
    }
    return newestFirst(
      names.filter((name) => {
        if (!parseVersion(name)) return false;
        return provider.binaries.every((binary) => {
          try {
            return lstatSync(join(this.#versionDir(id, name), "bin", binary)).isFile();
          } catch {
            return false;
          }
        });
      }),
    );
  }

  /** What can be downloaded, cached for hours (and a failure for minutes). */
  async available(id: RuntimeId, options: { fresh?: boolean } = {}): Promise<RuntimeRelease[]> {
    const cached = this.#available.get(id);
    if (cached && !options.fresh) {
      const age = Date.now() - cached.at;
      if (cached.releases && age < AVAILABLE_TTL_MS) return cached.releases;
      if (cached.error && age < AVAILABLE_ERROR_TTL_MS) throw new Error(cached.error);
    }
    const running = this.#availableInFlight.get(id);
    if (running) return running;
    const job = this.#provider(id)
      .listAvailable()
      .then(
        (releases) => {
          const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
          this.#available.set(id, { at: Date.now(), releases: sorted });
          return sorted;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.#available.set(id, { at: Date.now(), error: message });
          throw new Error(message);
        },
      )
      .finally(() => this.#availableInFlight.delete(id));
    this.#availableInFlight.set(id, job);
    return job;
  }

  /** Installs being downloaded for a runtime. */
  installing(id: RuntimeId): RuntimeInstallProgress[] {
    return [...this.#installs.entries()].filter(([key]) => key.startsWith(`${id}@`)).map(([, i]) => ({ ...i.progress }));
  }

  /**
   * Installs `version` once, however many ask at the same time: a second
   * caller is given the first one's promise. `projectId` is told (through
   * `changed`) when it starts and when it ends.
   */
  install(id: RuntimeId, version: string, projectId?: string): Promise<void> {
    const key = `${id}@${version}`;
    const running = this.#installs.get(key);
    if (running) {
      if (projectId) running.waiters.add(projectId);
      return running.promise;
    }
    if (this.installed(id).includes(version)) return Promise.resolve();
    if (!parseVersion(version)) return Promise.reject(new Error(`${version} is not a version`));
    const provider = this.#provider(id);

    const entry: Install = {
      promise: Promise.resolve(),
      progress: { version, received: 0, total: null },
      waiters: new Set(projectId ? [projectId] : []),
    };
    entry.promise = (async () => {
      const release = (await this.available(id)).find((r) => r.version === version);
      if (!release) throw new Error(`${RUNTIME_LABELS[id]} ${version} is not offered for download`);
      const parent = join(this.options.root, id);
      await mkdir(parent, { recursive: true });
      // Beside the final folder, so the rename is on one filesystem; a
      // dot-name, so `installed` never lists a half-made one.
      const temp = join(parent, `.tmp-${version}-${randomBytes(4).toString("hex")}`);
      await mkdir(temp);
      try {
        await provider.install(release, temp, {
          onProgress: (received, total) => {
            entry.progress = { version, received, total };
          },
        });
        await rename(temp, this.#versionDir(id, version)).catch(async (error: NodeJS.ErrnoException) => {
          // Installed by another process in the meantime: theirs stands.
          if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
        });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    })();
    this.#installs.set(key, entry);
    for (const waiter of entry.waiters) this.options.changed?.(waiter);

    entry.promise
      .then(
        () => {
          this.#lastError.delete(id);
          // The projects that waited on it switch now, open terminals too,
          // rather than at their next spawn.
          for (const waiter of entry.waiters) {
            try {
              this.reconcile(waiter, projectRoot(this.options.workspaceRoot, waiter));
            } catch (error) {
              this.options.log?.(error, "could not link a freshly installed runtime");
            }
          }
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.#lastError.set(id, `${RUNTIME_LABELS[id]} ${version}: ${message}`);
          this.options.log?.(error, `could not install ${id} ${version}`);
        },
      )
      .finally(() => {
        this.#installs.delete(key);
        for (const waiter of entry.waiters) this.options.changed?.(waiter);
      });
    return entry.promise;
  }

  /** Every project whose link points at that version. */
  projectsUsing(id: RuntimeId, version: string): string[] {
    const provider = this.#provider(id);
    const binary = provider.binaries[0];
    if (!binary) return [];
    let projects: string[];
    try {
      projects = readdirSync(join(this.options.root, "projects"));
    } catch {
      return [];
    }
    const target = this.#linkTarget(projects[0] ?? "", id, version, binary);
    return projects.filter((projectId) => {
      try {
        return readlinkSync(join(this.binDir(projectId), binary)) === target;
      } catch {
        return false;
      }
    });
  }

  /** Removes an installed version no project uses. */
  async uninstall(id: RuntimeId, version: string): Promise<void> {
    if (!parseVersion(version)) throw new Error(`${version} is not a version`);
    const users = this.projectsUsing(id, version);
    if (users.length > 0) {
      throw new RuntimeInUseError(
        `${RUNTIME_LABELS[id]} ${version} is in use by ${users.length} project${users.length === 1 ? "" : "s"}`,
      );
    }
    await rm(this.#versionDir(id, version), { recursive: true, force: true });
  }

  /** The link's text: relative, so the whole root can move. Same for every project. */
  #linkTarget(projectId: string, id: RuntimeId, version: string, binary: string): string {
    return relative(this.binDir(projectId), join(this.#versionDir(id, version), "bin", binary));
  }

  /**
   * Points the project's links at what its selections resolve to, now, and
   * answers what that is (null: the system's own). Synchronous: called as a
   * terminal opens. A selection nothing installed satisfies starts an
   * install in the background, when that is allowed.
   */
  reconcile(projectId: string, root: string): Record<RuntimeId, string | null> {
    const bin = this.binDir(projectId);
    mkdirSync(bin, { recursive: true });
    const { selections } = readSelections(root);
    const resolved = {} as Record<RuntimeId, string | null>;
    for (const provider of this.providers) {
      const selection = selections[provider.id] ?? RUNTIME_DEFAULT_SELECTION;
      const version = pickVersion(selection, this.installed(provider.id));
      resolved[provider.id] = version;
      for (const binary of provider.binaries) {
        const link = join(bin, binary);
        if (version) setLink(link, this.#linkTarget(projectId, provider.id, version, binary));
        else rmSync(link, { force: true });
      }
      if (!version && selection !== "system") this.#autoInstall(provider.id, selection, projectId);
    }
    return resolved;
  }

  /**
   * The folder to put first on PATH for a process started in `cwd`, with its
   * links brought up to date; null when `cwd` is not in a project. Never
   * throws: a runtime that cannot be set up leaves the system's.
   */
  pathFor(cwd: string): string | null {
    const projectId = projectIdOfPath(this.options.workspaceRoot, cwd);
    if (!projectId) return null;
    try {
      this.reconcile(projectId, projectRoot(this.options.workspaceRoot, projectId));
      return this.binDir(projectId);
    } catch (error) {
      this.options.log?.(error, "could not set up a project's runtimes");
      return null;
    }
  }

  /** At boot: the newest stable version of each runtime nothing is installed of. */
  ensureDefaults(): void {
    for (const provider of this.providers) {
      if (this.installed(provider.id).length === 0) this.#autoInstall(provider.id, RUNTIME_DEFAULT_SELECTION);
    }
  }

  #autoInstall(id: RuntimeId, selection: string, projectId?: string): void {
    if (!this.options.autoInstall) return;
    const key = `${id}:${selection}`;
    const tried = this.#autoTried.get(key);
    if (tried !== undefined && Date.now() - tried < AUTO_RETRY_MS) return;
    this.#autoTried.set(key, Date.now());
    void (async () => {
      const want = await this.wanted(id, selection);
      if (!want) throw new Error(`no ${RUNTIME_LABELS[id]} release matches ${selection}`);
      await this.install(id, want, projectId);
      this.#autoTried.delete(key);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#lastError.has(id)) this.#lastError.set(id, message);
      this.options.log?.(error, `could not install ${id} ${selection} automatically`);
    });
  }

  /** The downloadable version a selection would take: what "Update" installs. */
  async wanted(id: RuntimeId, selection: string): Promise<string | null> {
    if (selection === "system") return null;
    return pickVersion(
      selection,
      (await this.available(id)).map((r) => r.version),
    );
  }

  /** The system's own version of a runtime (`php` on the server's PATH). */
  systemVersion(id: RuntimeId): Promise<string | null> {
    const cached = this.#system.get(id);
    if (cached && Date.now() - cached.at < SYSTEM_TTL_MS) return cached.version;
    const provider = this.#provider(id);
    const version = provider.versionOf(provider.binaries[0] ?? id);
    this.#system.set(id, { at: Date.now(), version });
    return version;
  }

  /** Everything the settings card shows for one project. */
  async status(projectId: string, root: string): Promise<ProjectRuntimesResponse> {
    const { selections, error } = readSelections(root);
    const resolved = this.reconcile(projectId, root);
    const runtimes: ProjectRuntimeStatus[] = [];
    for (const provider of this.providers) {
      const id = provider.id;
      const selection = selections[id] ?? RUNTIME_DEFAULT_SELECTION;
      let available: string[] | null = null;
      let availableError: string | null = null;
      try {
        available = (await this.available(id)).map((r) => r.version);
      } catch (e) {
        availableError = e instanceof Error ? e.message : String(e);
      }
      const current = resolved[id] ?? null;
      const want = available && selection !== "system" ? pickVersion(selection, available) : null;
      const exact = parseVersion(selection) !== null;
      const system = await this.systemVersion(id);
      const constraint = provider.constraintOf?.(root) ?? null;
      const effective = selection === "system" ? system : current;
      runtimes.push({
        id,
        label: RUNTIME_LABELS[id],
        selection,
        resolved: current,
        system,
        installed: this.installed(id),
        available,
        availableError,
        update: current && want && !exact && compareVersions(want, current) > 0 ? want : null,
        missing: !current && selection !== "system" ? (want ?? (exact ? selection : null)) : null,
        installing: this.installing(id),
        lastError: this.#lastError.get(id) ?? null,
        constraint,
        satisfies: constraint && effective ? satisfiesConstraint(constraint, effective) : null,
      });
    }
    return { runtimes, error };
  }
}

/** Makes `link` point at `target`, swapping it in by rename so no reader sees it missing. */
function setLink(link: string, target: string): void {
  try {
    if (readlinkSync(link) === target) return;
  } catch {
    // Absent, or not a link: replaced below.
  }
  const temp = `${link}.${randomBytes(4).toString("hex")}.tmp`;
  symlinkSync(target, temp);
  try {
    renameSync(temp, link);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
