import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  FRAMEWORK_FILE,
  FRAMEWORK_LABELS,
  FRAMEWORK_PROFILES,
  FRAMEWORK_STACK,
  FrameworkFile,
  PROJECT_COMMANDS_MAX,
  RUNTIME_LABELS,
  fillScaffold,
  planFramework,
  resolveFrameworkOptions,
  scaffoldNames,
  type FrameworkCommand,
  type FrameworkId,
  type FrameworkPlan,
  type ProjectCommand,
  type ScaffoldNames,
  type RuntimeId,
} from "@ucch/protocol";

import { agentPath, writeIfChanged } from "./agent-sync.js";
import { ensureGitignored, refreshIndexFiles, refuseLink, writeEnvDefaults, writeFrameworkSection } from "./dev-database.js";
import { readCommands, writeCommands } from "./project-commands.js";
import { readSelections, writeSelections, type RuntimeManager } from "./runtimes/manager.js";

/**
 * Framework profiles applied to a project (plan3 §3). The profile itself is
 * data in `@ucch/protocol`'s `frameworks.ts`; this file writes what it says
 * into the project's committed `.agent/` files, additively:
 *
 * - runtimes.json gets the selections it lacks, the repository's own
 *   requirement (composer.json, package.json, global.json,
 *   rust-toolchain.toml) winning over the profile's default;
 * - commands.json gets the buttons it lacks, up to its limit;
 * - `.env` gets the defaults it lacks;
 * - framework-owned files (`.cargo/config.toml`) are written only when absent;
 * - framework.json records the choice, and what the profile wrote, so a
 *   later change of framework replaces only what nobody has edited since.
 *
 * The per-process environment is not written anywhere: `frameworkProcessEnv`
 * reads framework.json at every spawn, as the runtime links do.
 */

const MAX_FILE_BYTES = 64 * 1024;
const SCAFFOLD_TIMEOUT_MS = 5 * 60_000;
/** How long a starter waits for its toolchain to download. */
const TOOLCHAIN_WAIT_MS = 15 * 60_000;

export interface FrameworkRead {
  file: FrameworkFile | null;
  /** Why the file could not be used; null when it was fine or absent. */
  error: string | null;
}

/** `.agent/framework.json`, read synchronously (a terminal opens synchronously). */
export function readFrameworkFile(root: string): FrameworkRead {
  const path = join(root, FRAMEWORK_FILE);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { file: null, error: null };
  }
  if (info.isSymbolicLink()) return { file: null, error: "framework.json is a symlink; it is not read" };
  if (!info.isFile()) return { file: null, error: "framework.json is not a file" };
  if (info.size > MAX_FILE_BYTES) return { file: null, error: "framework.json is too large" };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { file: null, error: `framework.json is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = FrameworkFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { file: null, error: `framework.json: ${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}` };
  }
  return { file: parsed.data, error: null };
}

async function writeFrameworkFile(root: string, file: FrameworkFile): Promise<void> {
  const path = await agentPath(root, "framework.json");
  await writeIfChanged(path, `${JSON.stringify(FrameworkFile.parse(file), null, 2)}\n`);
}

/**
 * The variables a framework sets on every process the project starts
 * (`ASPNETCORE_URLS`, `CARGO_TERM_COLOR`, …), from framework.json; empty
 * without one. Never throws.
 */
export function frameworkProcessEnv(root: string): Record<string, string> {
  const { file } = readFrameworkFile(root);
  if (!file?.framework) return {};
  try {
    return planFramework(file.framework, file.options).processEnv;
  } catch {
    return {};
  }
}

/** A command's fingerprint: what the profile wrote, to tell later whether anyone edited it. */
export function commandHash(command: FrameworkCommand | ProjectCommand): string {
  const { id, label, command: line, description, icon } = command;
  return createHash("sha256")
    .update(JSON.stringify({ id, label, command: line, description: description ?? null, icon: icon ?? null }))
    .digest("hex")
    .slice(0, 16);
}

/** Which file stated each runtime's requirement, for the record. */
const CONSTRAINT_FILES: Partial<Record<RuntimeId, string>> = {
  php: "composer.json",
  node: "package.json or .nvmrc",
  bun: "package.json",
  dotnet: "global.json",
  rust: "rust-toolchain.toml",
};

export interface ApplyOptions {
  runtimes: RuntimeManager;
  /** Now, for `appliedAt`. */
  now?: () => Date;
}

export interface ApplyResult {
  file: FrameworkFile;
  plan: FrameworkPlan;
  /** The runtime selections in effect afterwards, for the context section. */
  selections: Partial<Record<RuntimeId, string>>;
}

/**
 * Applies `id` with `given` options to the checkout at `root`. Additive;
 * re-running it is harmless. With a previous framework.json, what that
 * profile wrote and nobody edited -- a command button, a runtime selection
 * -- is replaced or removed; everything else stays.
 */
export async function applyProfile(
  root: string,
  id: FrameworkId,
  given: Record<string, unknown>,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { options: chosen } = resolveFrameworkOptions(id, given);
  const plan = planFramework(id, chosen);
  const previous = readFrameworkFile(root).file;
  const providers = new Map(options.runtimes.providers.map((p) => [p.id, p]));

  // 1. The repository's own requirements win over the profile's defaults.
  const wanted: Partial<Record<RuntimeId, string>> = {};
  const overrides: Record<string, string> = {};
  for (const [runtime, selection] of Object.entries(plan.runtimes) as [RuntimeId, string][]) {
    const provider = providers.get(runtime);
    const constraint = provider?.constraintOf?.(root) ?? null;
    const stated = constraint ? (provider?.selectionFor?.(constraint) ?? null) : null;
    wanted[runtime] = stated ?? selection;
    if (constraint) overrides[runtime] = `${constraint} (from ${CONSTRAINT_FILES[runtime] ?? "the repository"})`;
  }

  // 2. runtimes.json: what it lacks, and what the old profile set and nobody changed.
  const { selections: current } = readSelections(root);
  const previousRuntimes = (previous?.runtimes ?? {}) as Record<string, string>;
  const write: Partial<Record<RuntimeId, string>> = {};
  for (const [runtime, selection] of Object.entries(wanted) as [RuntimeId, string][]) {
    const have = current[runtime];
    if (have === undefined || (previousRuntimes[runtime] === have && have !== selection)) write[runtime] = selection;
  }
  if (Object.keys(write).length) await writeSelections(root, write);
  const selections = { ...current, ...write };

  // 3. commands.json: added when missing; the old profile's unedited ones replaced or removed.
  const { commands: existing, error: commandsError } = readCommands(root);
  const owned = (previous?.commands ?? {}) as Record<string, string>;
  const ownedHashes: Record<string, string> = {};
  if (!commandsError) {
    const byId = new Map(existing.map((c) => [c.id, c]));
    const planned = new Map(plan.commands.map((c) => [c.id, c]));
    const next: ProjectCommand[] = [];
    for (const command of existing) {
      const untouched = owned[command.id] !== undefined && owned[command.id] === commandHash(command);
      const replacement = planned.get(command.id);
      if (untouched && !replacement) continue; // the old profile's, unedited, and not in the new one
      if (untouched && replacement) {
        next.push(replacement as ProjectCommand);
        ownedHashes[command.id] = commandHash(replacement);
        continue;
      }
      next.push(command);
    }
    for (const command of plan.commands) {
      if (byId.has(command.id) || next.length >= PROJECT_COMMANDS_MAX) continue;
      next.push(command as ProjectCommand);
      ownedHashes[command.id] = commandHash(command);
    }
    if (JSON.stringify(next) !== JSON.stringify(existing)) await writeCommands(root, next);
  }

  // 4. `.env` defaults, only for keys it lacks; ignored by git before it holds anything.
  if (Object.keys(plan.env).length) {
    await ensureGitignored(root, ".env");
    await writeEnvDefaults(root, plan.env);
  }

  // 5. Framework-owned config files, only when absent.
  for (const file of plan.files) {
    const path = join(root, file.path);
    if (await lstat(path).catch(() => null)) continue;
    await refuseLink(dirname(path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { flag: "wx" }).catch(() => {});
  }

  // 6. The record.
  const file: FrameworkFile = {
    framework: id,
    options: chosen,
    appliedAt: (options.now?.() ?? new Date()).toISOString(),
    ...(Object.keys(overrides).length ? { overrides } : {}),
    runtimes: wanted,
    commands: ownedHashes,
  };
  await writeFrameworkFile(root, file);
  await writeFrameworkSection(root, frameworkSection(file, plan, selections));
  await refreshIndexFiles(root);
  return { file, plan, selections };
}

/** Records "not a framework project": the auto-detect offer is not made again (plan3 §3.7). */
export async function dismissFramework(root: string): Promise<void> {
  const previous = readFrameworkFile(root).file;
  if (previous?.framework) return;
  await writeFrameworkFile(root, { framework: null, options: {}, dismissed: true });
  await refreshIndexFiles(root);
}

/**
 * The `## Framework` section of `.agent/index.md` (plan3 §3.5): what an
 * agent needs to use the project's own tools. Written once into the file,
 * not into any per-turn prompt, and budgeted in `agent-context-budget.json`.
 */
export function frameworkSection(file: FrameworkFile, plan: FrameworkPlan, selections: Partial<Record<RuntimeId, string>>): string {
  if (!file.framework) return "";
  const runtimes = Object.keys(plan.runtimes)
    .map((id) => `${RUNTIME_LABELS[id as RuntimeId]} ${selections[id as RuntimeId] ?? plan.runtimes[id as RuntimeId]}`)
    .join(", ");
  const commands = plan.commands
    .filter((c) => ["dev", "test", "lint", "typecheck", "build", "format"].includes(c.id))
    .map((c) => `${c.label}: \`${c.command.length > 80 ? `${c.command.slice(0, 77)}...` : c.command}\``)
    .join("; ");
  const lines = [
    "## Framework",
    "",
    `- ${FRAMEWORK_LABELS[file.framework]}${runtimes ? `, on ${runtimes}` : ""} (.agent/runtimes.json; choices in .agent/framework.json).`,
    ...(commands ? [`- Commands: ${commands}.`] : []),
    `- ${plan.agentHint}`,
  ];
  return lines.join("\n");
}

// --- the starter -----------------------------------------------------------------

export interface ScaffoldOptions {
  /** PATH first folder and variables for the project's processes: `pathFor` and `envFor`. */
  path: string | null;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Wraps an argv the way the server runs every child (priority, sandbox). */
  wrapArgv?: (argv: string[]) => string[];
}

/**
 * Makes the framework's starter project in `root` (plan3 §3.2): the
 * starter tools run with the project's own runtimes, in a fresh folder
 * inside it -- they refuse a folder with `.git` in it -- whose contents are
 * then moved up, never over a file already there. Throws with what failed.
 */
export async function scaffoldProject(root: string, id: FrameworkId, given: Record<string, unknown>, projectName: string, options: ScaffoldOptions): Promise<void> {
  const { options: chosen } = resolveFrameworkOptions(id, given);
  const scaffold = FRAMEWORK_PROFILES[id].scaffold?.(chosen);
  if (!scaffold) return;
  const names = scaffoldNames(projectName);
  const temp = join(root, names.dir);
  await rm(temp, { recursive: true, force: true });
  const deadline = Date.now() + (options.timeoutMs ?? SCAFFOLD_TIMEOUT_MS);
  const env: NodeJS.ProcessEnv = {
    PATH: options.path ? `${options.path}:${process.env.PATH ?? "/usr/bin:/bin"}` : (process.env.PATH ?? "/usr/bin:/bin"),
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    CI: "1",
    // No prompts from anything: every tool here asks only when it has a TTY or no CI.
    npm_config_yes: "true",
    COMPOSER_NO_INTERACTION: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    ...options.env,
  };
  const step = async (argv: string[], cwd: string) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("the starter took longer than five minutes");
    await runArgv(options.wrapArgv ? options.wrapArgv(argv) : argv, cwd, env, left, options.signal);
  };
  try {
    for (const argv of scaffold.create) await step(fillScaffold(argv, names), root);
    if (!(await lstat(temp).catch(() => null))?.isDirectory()) throw new Error("the starter made no project folder");
    await moveUp(temp, root);
    await renamePackage(root, names);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  for (const file of scaffold.write ?? []) {
    const path = join(root, file.path);
    await refuseLink(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  for (const argv of scaffold.after ?? []) await step(fillScaffold(argv, names), root);
}

/** The starters name a package after the folder they made: the project's name instead. */
async function renamePackage(root: string, names: ScaffoldNames): Promise<void> {
  const path = join(root, "package.json");
  const text = await readFile(path, "utf8").catch(() => null);
  if (!text || !text.includes(`"${names.dir}"`)) return;
  await writeFile(path, text.replace(`"name": "${names.dir}"`, `"name": "${names.name}"`));
}

/** Moves every entry of `from` into `to`, skipping a name `to` already has (its `.git`, its README). */
async function moveUp(from: string, to: string): Promise<void> {
  for (const name of await readdir(from)) {
    if (name === ".git") continue;
    const target = join(to, name);
    if (name === ".gitignore" && (await lstat(target).catch(() => null))?.isFile()) {
      // Both: the starter's rules (vendor/, node_modules/) and what was already ignored (.env).
      const have = await readFile(target, "utf8");
      const lines = new Set(have.split("\n").map((l) => l.trim()));
      const add = (await readFile(join(from, name), "utf8")).split("\n").filter((l) => l.trim() && !lines.has(l.trim()));
      if (add.length) await writeFile(target, `${have}${have.endsWith("\n") || !have ? "" : "\n"}${add.join("\n")}\n`);
      continue;
    }
    if (name === ".env" && (await lstat(target).catch(() => null))?.isFile()) {
      // The profile's defaults (or DATABASE_URL) were written first; the
      // starter's own -- Laravel's APP_KEY -- join them where they are new.
      const have = await readFile(target, "utf8");
      const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      const present = new Set(have.split("\n").map(keyOf).filter(Boolean));
      const add = (await readFile(join(from, name), "utf8")).split("\n").filter((line) => {
        const key = keyOf(line);
        return key && !present.has(key);
      });
      if (add.length) await writeFile(target, `${have}${have.endsWith("\n") || !have ? "" : "\n"}${add.join("\n")}\n`, { mode: 0o600 });
      continue;
    }
    if (await lstat(target).catch(() => null)) {
      // The starter's README replaces the placeholder one `git init` wrote; anything else stays.
      if (name !== "README.md") continue;
      await rm(target, { force: true });
    }
    await rename(join(from, name), target);
  }
}

function runArgv(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const [file, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(file!, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, ...(signal ? { signal } : {}) });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new Error(`${argv.slice(0, 3).join(" ")} took too long`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${file} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${code}): ${lastLines(tail)}`));
    });
  });
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-4).join(" / ").slice(-400);
}

// --- the service ----------------------------------------------------------------

export interface FrameworkServiceOptions {
  runtimes: RuntimeManager;
  /** `FRAMEWORK_SCAFFOLD`: whether starters may be made at all. */
  scaffold: boolean;
  wrapArgv?: (argv: string[]) => string[];
  log?(error: unknown, context: string): void;
}

export interface SetUpResult {
  scaffoldError?: string;
  /** The section for `index.md`, when a profile was applied. */
  section?: string;
  previewPort: number | null;
  previewStaticDir: string | null;
}

/**
 * What the clone reactor and the framework reactor call: set a project up
 * for a framework, at creation (with its starter, when it was started empty
 * and asked for one) or later.
 */
export class FrameworkService {
  constructor(private readonly options: FrameworkServiceOptions) {}

  get scaffoldAvailable(): boolean {
    return this.options.scaffold;
  }

  async setUp(
    projectId: string,
    root: string,
    choice: { id: FrameworkId; options: Record<string, unknown>; scaffold?: boolean },
    context: { projectName: string; empty: boolean },
  ): Promise<SetUpResult> {
    let scaffoldError: string | undefined;
    // The runtimes first: the starter needs them, and the selection the
    // repository states is read before anything is generated.
    let applied = await applyProfile(root, choice.id, choice.options, { runtimes: this.options.runtimes });
    if (choice.scaffold && context.empty && this.options.scaffold) {
      try {
        await this.#toolchains(projectId, root, applied.selections);
        await scaffoldProject(root, choice.id, choice.options, context.projectName, {
          path: this.options.runtimes.pathFor(root),
          env: { ...this.options.runtimes.envFor(root), ...applied.plan.processEnv },
          ...(this.options.wrapArgv ? { wrapArgv: this.options.wrapArgv } : {}),
        });
        // Again, over the starter: its own files (package.json's engines,
        // a global.json) and the `.env` it made are read now.
        applied = await applyProfile(root, choice.id, choice.options, { runtimes: this.options.runtimes });
      } catch (error) {
        scaffoldError = `The ${FRAMEWORK_LABELS[choice.id]} starter was not made: ${error instanceof Error ? error.message : String(error)}`;
        this.options.log?.(error, "framework starter failed");
      }
    }
    return {
      ...(scaffoldError ? { scaffoldError } : {}),
      section: frameworkSection(applied.file, applied.plan, applied.selections),
      previewPort: applied.plan.previewPort,
      previewStaticDir: applied.plan.previewStaticDir,
    };
  }

  /** Installs what the selections need and waits for it, so the starter has its tools. */
  async #toolchains(projectId: string, root: string, selections: Partial<Record<RuntimeId, string>>): Promise<void> {
    const runtimes = this.options.runtimes;
    const jobs: Promise<void>[] = [];
    for (const [id, selection] of Object.entries(selections) as [RuntimeId, string][]) {
      if (selection === "system" || runtimes.pickInstalled(id, selection)) continue;
      jobs.push(
        (async () => {
          const want = await runtimes.wanted(id, selection);
          if (!want) throw new Error(`no ${RUNTIME_LABELS[id]} release matches ${selection}`);
          await runtimes.install(id, want, projectId);
        })(),
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(jobs),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("the toolchain download took longer than fifteen minutes")), TOOLCHAIN_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    runtimes.reconcile(projectId, root);
  }

  /** A change of framework after creation (plan3 §3.6), or the offer dismissed. */
  async change(root: string, choice: { id: FrameworkId; options: Record<string, unknown> } | null): Promise<void> {
    if (!choice) {
      await dismissFramework(root);
      return;
    }
    await applyProfile(root, choice.id, choice.options, { runtimes: this.options.runtimes });
  }
}

/** "Repository looks like Laravel", when the chosen framework is not what the files say. */
export function frameworkWarning(chosen: FrameworkId, stack: string): string | undefined {
  if (FRAMEWORK_STACK[chosen] === stack) return undefined;
  const looks = Object.entries(FRAMEWORK_STACK).find(([, s]) => s === stack)?.[0] as FrameworkId | undefined;
  return looks ? `The repository looks like ${FRAMEWORK_LABELS[looks]}, not ${FRAMEWORK_LABELS[chosen]}.` : undefined;
}
