import { constants, copyFile, lstat, mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  DATABASE_ENGINE_LABELS,
  DEFAULT_DB_PORTS,
  PROJECT_MODE_LABELS,
  type DatabaseEngine,
  type DomainEvent,
  type ProjectDatabase,
} from "@ucch/protocol";
import { MAX_INSTRUCTIONS_BYTES, MAX_KNOWLEDGE_ENTRIES, renderKnowledge } from "@ucch/agent";
import { adapterFor as defaultAdapterFor, type DbAdapter, type DbTarget } from "./db-manager/index.js";

type ProjectCreated = Extract<DomainEvent, { type: "project.created" }>;

/** The shared servers projects' databases are made on, by engine. Either may be missing. */
export type DevDatabaseServers = Partial<Record<DatabaseEngine, DbTarget>>;

/**
 * Reads a `DEV_POSTGRES_URL` / `DEV_MYSQL_URL` into something an adapter can
 * open. The path names the database the account connects to by default --
 * `dev` -- which is also what a PostgreSQL session needs to exist at all.
 */
export function devServerFromUrl(engine: DatabaseEngine, url: string): DbTarget {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    engine,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : DEFAULT_DB_PORTS[engine],
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: database || null,
  };
}

/** Both servers from config, leaving out whichever is not configured. */
export function devServersFromConfig(config: {
  DEV_POSTGRES_URL?: string;
  DEV_MYSQL_URL?: string;
}): DevDatabaseServers {
  return {
    ...(config.DEV_POSTGRES_URL ? { postgresql: devServerFromUrl("postgresql", config.DEV_POSTGRES_URL) } : {}),
    ...(config.DEV_MYSQL_URL ? { mysql: devServerFromUrl("mysql", config.DEV_MYSQL_URL) } : {}),
  };
}

/** The URL an application uses to reach one database on a dev server. */
export function databaseUrl(server: DbTarget, name: string): string {
  const scheme = server.engine === "mysql" ? "mysql" : "postgres";
  const auth = `${encodeURIComponent(server.username)}:${encodeURIComponent(server.password)}`;
  return `${scheme}://${auth}@${server.host}:${server.port}/${name}`;
}

/**
 * Makes the project's database on the shared server, unless it is already
 * there.
 *
 * Existing is success rather than a conflict: a redelivered `project.created`
 * must come out the same, and the name was the person's choice -- two projects
 * that pick the same one share it, which is what they asked for.
 */
export async function ensureDevDatabase(
  server: DbTarget,
  name: string,
  adapterFor: (target: DbTarget, db: string | null) => DbAdapter = defaultAdapterFor,
): Promise<void> {
  const adapter = adapterFor(server, null);
  const existing = await adapter.listDatabases();
  if (existing.includes(name)) return;
  await adapter.createDatabase(name);
}

/**
 * Sets `DATABASE_URL` in the project's `.env`, keeping everything else in it.
 *
 * Replaced rather than appended when it is already there, so the file never
 * carries two answers to the one question every framework asks it.
 */
export async function writeDatabaseUrl(dir: string, url: string): Promise<void> {
  const path = join(dir, ".env");
  await refuseLink(path);
  const current = await readFile(path, "utf8").catch(() => "");
  const line = `DATABASE_URL=${url}`;
  const lines = current.split("\n");
  const at = lines.findIndex((l) => /^\s*(export\s+)?DATABASE_URL=/.test(l));
  let next: string;
  if (at >= 0) {
    lines[at] = line;
    next = lines.join("\n");
  } else {
    next = current && !current.endsWith("\n") ? `${current}\n${line}\n` : `${current}${line}\n`;
  }
  await writeFile(path, next, { mode: 0o600 });
}

/**
 * Makes sure `.gitignore` covers `entry`. The `.env` carries a password, and a
 * commit is the easiest way for one to leave the machine.
 */
export async function ensureGitignored(dir: string, entry: string): Promise<void> {
  const path = join(dir, ".gitignore");
  await refuseLink(path);
  const current = await readFile(path, "utf8").catch(() => "");
  const covered = current
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l === entry || l === `/${entry}`);
  if (covered) return;
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${current}${sep}${entry}\n`);
}

/**
 * Refuses to read or rewrite a file that is a symlink.
 *
 * Everything this file writes lands straight after a clone, into a tree the
 * repository's author controls: a `.env -> /some/host/file` would otherwise
 * have that file rewritten -- with the shared database password in it.
 */
async function refuseLink(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink()) throw new Error(`${basename(path)} is a symlink; refusing to write through it`);
}

/** What `.ucch/INFO.md` says about a project. */
export interface ProjectContext {
  event: ProjectCreated;
  stack: string;
  /** The server the project's database is on, when it has one. */
  server?: DbTarget;
}

/**
 * The project's settings as its agent and its people read them.
 *
 * No password: the file is meant to be committed if anybody wants it, and the
 * full connection string is in `.env` for whatever actually connects.
 */
export function renderContext({ event, stack, server }: ProjectContext): string {
  const mode = event.mode ?? "development";
  const lines = [
    `# ${event.name}`,
    "",
    "Project settings recorded by UltraChillCodingHarness when the project was created.",
    "Edit freely, people and agents alike: it is written once and never overwritten.",
    "",
    "## Project",
    "",
    `- Mode: ${PROJECT_MODE_LABELS[mode]}`,
    event.repoUrl
      ? `- Source: cloned from ${event.repoUrl} (branch \`${event.defaultBranch}\`)`
      : `- Source: started empty on branch \`${event.defaultBranch}\``,
    `- Stack: ${stack}`,
  ];

  if (event.database) {
    lines.push("", "## Development database", "");
    lines.push(`- Engine: ${DATABASE_ENGINE_LABELS[event.database.engine]}`);
    lines.push(`- Database: \`${event.database.name}\``);
    if (server) {
      lines.push(`- Host: \`${server.host}:${server.port}\``);
      lines.push(`- User: \`${server.username}\``);
    }
    lines.push(
      "- Connection string: `DATABASE_URL` in `.env` (git-ignored; it holds the password).",
      "",
      "This is a development database on a server shared by every project, so",
      "anything here is disposable. Never point it at production data.",
    );
  } else if (mode === "development") {
    lines.push("", "## Development database", "", "None. The project was created without one.");
  }

  lines.push("", UCCH_GUIDE);
  return `${lines.join("\n")}\n`;
}

/** The folder every project keeps its knowledge in, relative to its root. */
export const UCCH_DIR = ".ucch";
/** The file every harness loads on every turn. */
export const UCCH_INFO = ".ucch/INFO.md";
/** What `INFO.md` was called before it was the folder's index. */
const LEGACY_CONTEXT = ".ucch/context.md";
/** Diagrams that predate `.ucch/diagrams/`, carried over once. */
const LEGACY_DIAGRAMS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["docs/diagrams/database.mmd", ".ucch/diagrams/database.mmd"],
];

/** What `.ucch/` is for, said in the file every agent reads first. */
const UCCH_GUIDE = [
  "## The .ucch folder",
  "",
  "`.ucch/` is this project's knowledge base for AI agents. Every agent the harness",
  "runs -- whichever provider -- reads this file at the start of every turn and is",
  "shown the list of everything else in the folder.",
  "",
  "- `INFO.md`: this file. What the project is and how it is set up.",
  "- `diagrams/`: the diagrams on the project's documentation page, one Mermaid file (`.mmd`)",
  "  per tab -- the schema, the architecture, the system flow and the user flow.",
  "",
  "Read whatever here is relevant before working, refer to it, and keep it current",
  "when the project changes.",
].join("\n");

/** `INFO.md` for a project whose creation settings are not at hand. */
export function renderDefaultInfo(name?: string): string {
  return [
    `# ${name ?? "Project"}`,
    "",
    "Project information for AI agents working here. Edit freely, people and agents alike:",
    "the harness writes this file once and never overwrites it.",
    "",
    UCCH_GUIDE,
    "",
  ].join("\n");
}

/**
 * Makes sure the project has `.ucch/INFO.md` and `.ucch/diagrams/`.
 *
 * Idempotent and never overwrites: run when a project is created and again
 * before every agent turn, which is what backfills projects made before the
 * folder existed. `content` is used only when there is no `INFO.md` yet and
 * no `context.md` to promote into one.
 */
export async function ensureProjectInfo(dir: string, content?: string): Promise<void> {
  await refuseLink(join(dir, UCCH_DIR));
  await refuseLink(join(dir, UCCH_DIR, "diagrams"));
  await mkdir(join(dir, UCCH_DIR, "diagrams"), { recursive: true });

  const info = join(dir, UCCH_INFO);
  await refuseLink(info);
  if (!(await present(info))) {
    const legacy = join(dir, LEGACY_CONTEXT);
    const promotable = await lstat(legacy).then((s) => s.isFile(), () => false);
    if (promotable) {
      await rename(legacy, info);
    } else {
      try {
        await writeFile(info, content ?? renderDefaultInfo(), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  for (const [from, to] of LEGACY_DIAGRAMS) {
    // A plain file only: a symlink would copy a host file into the project.
    const source = await lstat(join(dir, from)).catch(() => null);
    if (!source?.isFile()) continue;
    await copyFile(join(dir, from), join(dir, to), constants.COPYFILE_EXCL).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
}

/**
 * `.ucch/` read from disk, in the same words the native loop gives its model.
 *
 * For the CLI providers, which run outside the native executor. Symlinks are
 * neither read nor followed: the folder is in a tree the repository's author
 * controls, and a link would put a host file in the model's context.
 */
export async function readProjectKnowledge(dir: string): Promise<string | null> {
  let info: string | null = null;
  for (const name of [UCCH_INFO, LEGACY_CONTEXT]) {
    const path = join(dir, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile()) continue;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_INSTRUCTIONS_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      info = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    break;
  }

  const files: string[] = [];
  // One past the cap, so the listing can still say there are more.
  const limit = MAX_KNOWLEDGE_ENTRIES + 2;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if ((await lstat(join(dir, UCCH_DIR)).catch(() => null))?.isDirectory()) await walk(UCCH_DIR);

  return renderKnowledge(info, files);
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
