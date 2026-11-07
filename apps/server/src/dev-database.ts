import { constants, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** What `.agent/index.md` says about a project. */
export interface ProjectContext {
  event: ProjectCreated;
  stack: string;
  /** The server the project's database is on, when it has one. */
  server?: DbTarget;
  /** What the application is, from `readProjectDescription`. */
  description?: string;
}

/**
 * The project's settings as its agent and its people read them.
 *
 * No password: the file is meant to be committed if anybody wants it, and the
 * full connection string is in `.env` for whatever actually connects.
 */
export function renderContext({ event, stack, server, description }: ProjectContext): string {
  const mode = event.mode ?? "development";
  const lines = [
    `# ${event.name}`,
    "",
    "Project settings recorded by UltraChillCodingHarness when the project was created.",
    "Edit freely, people and agents alike: it is written once, and afterwards the harness only",
    "refreshes the file list at the end.",
    "",
    ...aboutSection(description),
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

  lines.push("", AGENT_GUIDE);
  return `${lines.join("\n")}\n`;
}

/** The folder every project keeps its knowledge in, relative to its root. */
export const AGENT_DIR = ".agent";
/** The file every harness loads on every turn: what the project is, and what is in the folder. */
export const AGENT_INDEX = ".agent/index.md";
/** The project's environment variables, encrypted under its project key (`env-vault.ts`). */
export const AGENT_ENV = ".agent/env.val";
/** What the folder was called before it was `.agent`; moved over by `migrateLegacyFolder`. */
const LEGACY_DIR = ".ucch";
/** What `index.md` was called before, newest first. Promoted into `index.md` once. */
const LEGACY_INDEXES = [".agent/INFO.md", ".agent/context.md"];
/** Diagrams that predate `.agent/diagrams/`, carried over once. */
const LEGACY_DIAGRAMS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["docs/diagrams/database.mmd", ".agent/diagrams/database.mmd"],
];

/** The harness-maintained file list in `index.md` sits between these. */
const FILES_START = "<!-- agent:files:start -->";
const FILES_END = "<!-- agent:files:end -->";
/** Folders listed as one line rather than file by file: their contents are generated. */
const COLLAPSED: Record<string, string> = {
  "cache/": "the harness's cache; safe to delete",
  "doc-cache/": "documents converted for reading (PDF pages, sources); safe to delete",
};
/** One-line purposes for the files the harness knows. */
const PURPOSES: Record<string, string> = {
  "index.md": "this file: what the project is and what is in this folder",
  "env.val":
    "the project's environment variables, values encrypted with the project key; managed from the app's Environment Variables section -- do not edit or try to decrypt it",
  "diagrams/database.mmd": "Mermaid diagram: the database schema",
  "diagrams/architecture.mmd": "Mermaid diagram: the architecture",
  "diagrams/system-flow.mmd": "Mermaid diagram: the system flow",
  "diagrams/user-flow.mmd": "Mermaid diagram: the user flow",
};

/** What `.agent/` is for, said in the file every agent reads first. */
const AGENT_GUIDE = [
  "## The .agent folder",
  "",
  "`.agent/` is where this project keeps its application settings, context and knowledge",
  "for AI agents and the people working with them. Every agent the harness runs --",
  "whichever provider -- reads this file at the start of every turn.",
  "",
  "Read whatever here is relevant before working, refer to it, and keep it current when",
  "the project changes, the About section above included. The list below is kept up to",
  "date by the harness.",
].join("\n");

/** The most of a description `index.md` carries: one line, not the whole README. */
const MAX_DESCRIPTION_CHARS = 300;
/** Plenty for any manifest or opening paragraph; a larger file is cut, not read whole. */
const MAX_DESCRIPTION_SOURCE_BYTES = 64 * 1024;
/** For a project with nothing to detect: `index.md` still says what is wanted there. */
const DESCRIPTION_PLACEHOLDER = "_No description yet. Replace this line with one sentence on what the application does._";

function aboutSection(description?: string): string[] {
  return ["## About", "", description ?? DESCRIPTION_PLACEHOLDER];
}

/**
 * The first `maxBytes` of a plain file, or null when it is not one. Symlinks
 * are not followed: the tree is the repository author's, and a link would
 * put a host file in front of the model.
 */
async function readHead(path: string, maxBytes: number): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * One line of untrusted repository text, safe to put in `index.md`. A comment
 * opener goes too: the file list's markers are comments, and a description
 * carrying one would have `refreshIndexFiles` rewrite the wrong span.
 */
function oneLine(text: string): string | null {
  const line = text.replaceAll("<!--", "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  if (line.length <= MAX_DESCRIPTION_CHARS) return line;
  return `${line.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`;
}

/** The first paragraph of prose in a README: past the title, badges, HTML, lists and code. */
export function firstParagraph(markdown: string): string | null {
  const lines = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/);
  const isUnderline = (line: string | undefined) => line !== undefined && /^\s*(=+|-+)\s*$/.test(line);
  const paragraph: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const skip =
      !line ||
      isUnderline(line) ||
      isUnderline(lines[i + 1]) ||
      /^(#|<|!\[|\[!\[|\||[-*+] |\d+\. |\[[^\]]*\]:)/.test(line);
    if (skip) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.replace(/^>\s*/, ""));
  }
  return paragraph.length > 0 ? paragraph.join(" ") : null;
}

/**
 * What the application is, in a line: `description` from `package.json`, or
 * else the README's first paragraph. Null when neither says.
 */
export async function readProjectDescription(dir: string): Promise<string | null> {
  const manifest = await readHead(join(dir, "package.json"), MAX_DESCRIPTION_SOURCE_BYTES);
  if (manifest !== null) {
    try {
      const { description } = JSON.parse(manifest) as { description?: unknown };
      const line = typeof description === "string" ? oneLine(description) : null;
      if (line) return line;
    } catch {
      // Not JSON, or cut short by the cap: the README may still say.
    }
  }
  for (const name of ["README.md", "readme.md", "Readme.md", "README"]) {
    const readme = await readHead(join(dir, name), MAX_DESCRIPTION_SOURCE_BYTES);
    if (readme === null) continue;
    const paragraph = firstParagraph(readme);
    return paragraph ? oneLine(paragraph) : null;
  }
  return null;
}

/** `index.md` for a project whose creation settings are not at hand. */
export function renderDefaultInfo(name?: string, description?: string): string {
  return [
    `# ${name ?? "Project"}`,
    "",
    "Project information for AI agents working here. Edit freely, people and agents alike:",
    "the harness writes this file once and afterwards only refreshes the file list at the end.",
    "",
    ...aboutSection(description),
    "",
    AGENT_GUIDE,
    "",
  ].join("\n");
}

/**
 * Moves a project's `.ucch/` to `.agent/`, which is what the folder is called now.
 *
 * Renamed whole when `.agent/` is not there yet. When both are, whatever
 * `.ucch/` has that `.agent/` lacks is moved across -- `.agent/` wins every
 * conflict -- and `.ucch/` is removed. A `.ucch` that is a symlink, or not a
 * folder, is left alone: it was never the harness's, and following it would
 * move a host directory into the project.
 */
export async function migrateLegacyFolder(dir: string): Promise<void> {
  const legacy = join(dir, LEGACY_DIR);
  const info = await lstat(legacy).catch(() => null);
  if (!info?.isDirectory()) return;

  const target = join(dir, AGENT_DIR);
  await refuseLink(target);
  if (!(await present(target))) {
    await rename(legacy, target);
    return;
  }
  await moveMissing(legacy, target);
  await rm(legacy, { recursive: true, force: true });
}

/** Moves every entry of `from` that `to` lacks into it, recursing into folders both have. */
async function moveMissing(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const source = join(from, entry.name);
    const dest = join(to, entry.name);
    const existing = await lstat(dest).catch(() => null);
    if (!existing) {
      if (entry.isDirectory() || entry.isFile()) await rename(source, dest);
    } else if (entry.isDirectory() && existing.isDirectory()) {
      await moveMissing(source, dest);
    }
  }
}

/**
 * Makes sure the project has `.agent/index.md` and `.agent/diagrams/`, and
 * that the file list at the end of `index.md` matches the folder.
 *
 * Idempotent and never overwrites what people wrote: run when a project is
 * created and again before every agent turn, which is what moves projects
 * made with `.ucch/` over and backfills projects made before either existed.
 * `render` is called only when there is no `index.md` yet and nothing older
 * to promote into one, with the description detected from the project.
 */
export async function ensureProjectInfo(
  dir: string,
  render: (description?: string) => string = (description) => renderDefaultInfo(undefined, description),
): Promise<void> {
  await migrateLegacyFolder(dir);
  await refuseLink(join(dir, AGENT_DIR));
  await refuseLink(join(dir, AGENT_DIR, "diagrams"));
  await mkdir(join(dir, AGENT_DIR, "diagrams"), { recursive: true });

  const index = join(dir, AGENT_INDEX);
  await refuseLink(index);
  if (!(await present(index))) {
    let promoted = false;
    for (const name of LEGACY_INDEXES) {
      const legacy = join(dir, name);
      if (await lstat(legacy).then((s) => s.isFile(), () => false)) {
        await rename(legacy, index);
        promoted = true;
        break;
      }
    }
    if (!promoted) {
      try {
        await writeFile(index, render((await readProjectDescription(dir)) ?? undefined), { flag: "wx" });
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

  await refreshIndexFiles(dir);
}

/** `.agent/`'s files as `index.md` lists them, relative to the folder, generated folders collapsed. */
async function listAgentFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, AGENT_DIR, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length > MAX_KNOWLEDGE_ENTRIES) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (COLLAPSED[`${path}/`] !== undefined) files.push(`${path}/`);
        else await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await walk("");
  return files;
}

/** The file list block of `index.md`, markers included. */
export function renderFileList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_KNOWLEDGE_ENTRIES);
  const lines = shown.map((path) => {
    const purpose = PURPOSES[path] ?? COLLAPSED[path];
    return purpose ? `- \`${path}\`: ${purpose}` : `- \`${path}\``;
  });
  if (files.length > shown.length) lines.push(`- (and more)`);
  return [FILES_START, ...lines, FILES_END].join("\n");
}

/**
 * Rewrites the file list at the end of `index.md` to match the folder,
 * leaving every other line as whoever wrote it left it. Appended under its
 * own heading when the file has no list yet. Written only when it changed,
 * so a turn that added nothing does not touch the file.
 */
export async function refreshIndexFiles(dir: string): Promise<void> {
  const index = join(dir, AGENT_INDEX);
  const info = await lstat(index).catch(() => null);
  if (!info?.isFile()) return;
  const current = await readFile(index, "utf8");
  const block = renderFileList(await listAgentFiles(dir));

  const start = current.indexOf(FILES_START);
  const end = current.indexOf(FILES_END, start);
  let next: string;
  if (start >= 0 && end > start) {
    next = current.slice(0, start) + block + current.slice(end + FILES_END.length);
  } else {
    const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = `${current}${sep}## Files in .agent\n\n${block}\n`;
  }
  if (next !== current) await writeFile(index, next);
}

/**
 * `.agent/` read from disk, in the same words the native loop gives its model.
 *
 * For the CLI providers, which run outside the native executor. Symlinks are
 * neither read nor followed: the folder is in a tree the repository's author
 * controls, and a link would put a host file in the model's context.
 */
export async function readProjectKnowledge(dir: string): Promise<string | null> {
  let info: string | null = null;
  for (const name of [AGENT_INDEX, ...LEGACY_INDEXES]) {
    info = await readHead(join(dir, name), MAX_INSTRUCTIONS_BYTES);
    if (info !== null) break;
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
  if ((await lstat(join(dir, AGENT_DIR)).catch(() => null))?.isDirectory()) await walk(AGENT_DIR);

  return renderKnowledge(info, files);
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
