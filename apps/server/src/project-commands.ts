import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { PROJECT_COMMANDS_FILE, ProjectCommandsFile, type ProjectCommand } from "@ucch/protocol";

import { agentPath, writeIfChanged } from "./agent-sync.js";
import { refreshIndexFiles } from "./dev-database.js";

/**
 * `.agent/commands.json`: a project's command buttons.
 *
 * Read synchronously because the terminal reactor's `#open` is synchronous
 * by design (terminals.ts), and it is where a command is looked up: at the
 * moment it runs, from the file, never from what a client sent.
 */

/** The most of the file that is read; thirty commands fit many times over. */
const MAX_FILE_BYTES = 256 * 1024;

export interface CommandsRead {
  commands: ProjectCommand[];
  /** Why the file could not be used; null when it was fine or is simply absent. */
  error: string | null;
}

export function readCommands(root: string): CommandsRead {
  const path = join(root, PROJECT_COMMANDS_FILE);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { commands: [], error: null };
  }
  if (info.isSymbolicLink()) return { commands: [], error: "commands.json is a symlink; it is not read" };
  if (!info.isFile()) return { commands: [], error: "commands.json is not a file" };
  if (info.size > MAX_FILE_BYTES) return { commands: [], error: "commands.json is too large" };

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { commands: [], error: `commands.json is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = ProjectCommandsFile.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { commands: [], error: `commands.json: ${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}` };
  }
  return { commands: parsed.data.commands, error: null };
}

export function findCommand(root: string, id: string): ProjectCommand | null {
  return readCommands(root).commands.find((c) => c.id === id) ?? null;
}

export async function writeCommands(root: string, commands: ProjectCommand[]): Promise<void> {
  const file = ProjectCommandsFile.parse({ commands });
  const path = await agentPath(root, "commands.json");
  if (await writeIfChanged(path, `${JSON.stringify(file, null, 2)}\n`)) await refreshIndexFiles(root);
}

/**
 * A command's working directory, inside `root` or null. Resolved through
 * symlinks, so a link in the checkout cannot point the command at the host.
 */
export function commandCwd(root: string, cwd: string | undefined): string | null {
  const wanted = cwd?.trim() || ".";
  if (isAbsolute(wanted)) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(resolve(realRoot, wanted));
    const rel = relative(realRoot, real);
    if (rel === "") return real;
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".git")) return null;
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
