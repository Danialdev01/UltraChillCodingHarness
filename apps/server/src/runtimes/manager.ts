import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  IMPLICIT_RUNTIMES,
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

import { forceRemove } from "../project-files.js";
import { agentPath, writeIfChanged } from "../agent-sync.js";
import { refreshIndexFiles } from "../dev-database.js";
import { projectIdOfPath, projectRoot } from "../trees.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";
import { compareVersions, newestFirst, parseVersion, pickVersion, satisfiesConstraint, type TagsOf } from "./version.js";

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
 * is `latest` for PHP (`IMPLICIT_RUNTIMES`) and absent for the rest: a
 * project gets Node, .NET or Rust linked only once its file names them,
 * which is what a framework profile writes. With nothing installed the link
 * is absent and PATH falls through to the system's own.
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
  /**
   * The workspace a project is in, for its package caches; null when not
   * known yet, which gives the project caches of its own.
   */
  workspaceOf?(projectId: string): string | null;
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

/** Beside an installed version: what its index said of it (`lts`), for selections made later. */
const TAGS_FILE = ".ucch-tags.json";

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
    await forceRemove(join(this.options.root, "projects", projectId));
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
            // Followed: npm, bunx and Rust's tools are links inside the version.
            return statSync(join(this.#versionDir(id, name), "bin", binary)).isFile();
          } catch {
            return false;
          }
        });
      }),
    );
  }

  /** The installed version a selection picks, null for none. */
  pickInstalled(id: RuntimeId, selection: string): string | null {
    return pickVersion(selection, this.installed(id), this.#installedTags(id));
  }

  /**
   * The tags kept beside each installed version; for one installed without
   * them (by an older server), what the cached download index says.
   */
  #installedTags(id: RuntimeId): TagsOf {
    return (version) => {
      try {
        const tags = JSON.parse(readFileSync(join(this.#versionDir(id, version), TAGS_FILE), "utf8")) as unknown;
        return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
      } catch {
        return this.#available.get(id)?.releases?.find((r) => r.version === version)?.tags ?? [];
      }
    };
  }

  /** The tags the download index gives each version. */
  #availableTags(releases: RuntimeRelease[]): TagsOf {
    const byVersion = new Map(releases.map((r) => [r.version, r.tags ?? []]));
    return (version) => byVersion.get(version) ?? [];
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
        if (release.tags?.length) await writeFile(join(temp, TAGS_FILE), JSON.stringify(release.tags));
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
    await this.#provider(id).remove?.(version);
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
      const selection = this.#selection(provider.id, selections);
      const version = pickVersion(selection, this.installed(provider.id), this.#installedTags(provider.id));
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

  /** What a project asks for: its file's word, `latest` for an implicit runtime, else `system` (nothing linked). */
  #selection(id: RuntimeId, selections: Partial<Record<RuntimeId, string>>): string {
    return selections[id] ?? (IMPLICIT_RUNTIMES.includes(id) ? RUNTIME_DEFAULT_SELECTION : "system");
  }

  /**
   * The variables every process started in `cwd` gets besides PATH (plan3
   * §2.6): each package manager's cache in a folder of the project's
   * workspace -- never shared between workspaces, so one tenant's build
   * cannot poison another's cache -- and what a linked runtime needs
   * (`DOTNET_ROOT`, `RUSTUP_TOOLCHAIN`). `cargo install` lands in the
   * project's own bin folder, which is already on PATH. Empty when `cwd`
   * is not in a project. Never throws.
   */
  envFor(cwd: string): Record<string, string> {
    const projectId = projectIdOfPath(this.options.workspaceRoot, cwd);
    if (!projectId) return {};
    try {
      const workspace = this.options.workspaceOf?.(projectId) ?? null;
      const cache = join(this.options.root, "cache", workspace ? `w-${workspace}` : `p-${projectId}`);
      mkdirSync(cache, { recursive: true, mode: 0o700 });
      const env: Record<string, string> = {
        CARGO_HOME: join(cache, "cargo"),
        CARGO_INSTALL_ROOT: join(this.options.root, "projects", projectId),
        NUGET_PACKAGES: join(cache, "nuget"),
        DOTNET_CLI_HOME: join(cache, "dotnet"),
        COMPOSER_HOME: join(cache, "composer"),
        COMPOSER_CACHE_DIR: join(cache, "composer", "cache"),
        npm_config_cache: join(cache, "npm"),
        npm_config_store_dir: join(cache, "pnpm-store"),
        COREPACK_HOME: join(cache, "corepack"),
        YARN_CACHE_FOLDER: join(cache, "yarn"),
        BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
      };
      const resolved = this.reconcile(projectId, projectRoot(this.options.workspaceRoot, projectId));
      for (const provider of this.providers) {
        const version = resolved[provider.id];
        if (version && provider.processEnv) Object.assign(env, provider.processEnv(this.#versionDir(provider.id, version), version));
      }
      return env;
    } catch (error) {
      this.options.log?.(error, "could not set up a project's runtime environment");
      return {};
    }
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

  /**
   * At boot: what a download cut short by a restart left behind (a
   * half-unpacked `.tmp-*` folder, rustup's installer), then the newest
   * stable version of each implicit runtime nothing is installed of.
   */
  ensureDefaults(): void {
    for (const id of RUNTIME_IDS) {
      let names: string[] = [];
      try {
        names = readdirSync(join(this.options.root, id));
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".tmp-") || name.startsWith(".rustup-init-")) {
          rmSync(join(this.options.root, id, name), { recursive: true, force: true });
        }
      }
    }
    for (const provider of this.providers) {
      if (!IMPLICIT_RUNTIMES.includes(provider.id)) continue;
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
    const releases = await this.available(id);
    return pickVersion(
      selection,
      releases.map((r) => r.version),
      this.#availableTags(releases),
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
      const selection = this.#selection(id, selections);
      let available: string[] | null = null;
      let availableTags: TagsOf = () => [];
      let availableError: string | null = null;
      try {
        const releases = await this.available(id);
        available = releases.map((r) => r.version);
        availableTags = this.#availableTags(releases);
      } catch (e) {
        availableError = e instanceof Error ? e.message : String(e);
      }
      const current = resolved[id] ?? null;
      const want = available && selection !== "system" ? pickVersion(selection, available, availableTags) : null;
      const exact = parseVersion(selection) !== null;
      const system = await this.systemVersion(id);
      const constraint = provider.constraintOf?.(root) ?? null;
      const effective = selection === "system" ? system : current;
      runtimes.push({
        id,
        label: RUNTIME_LABELS[id],
        selection,
        used: IMPLICIT_RUNTIMES.includes(id) || selections[id] !== undefined,
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
