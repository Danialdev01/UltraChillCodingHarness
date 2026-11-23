import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { loginShell } from "./terminals.js";

/**
 * The server's PATH, brought up to date without a restart.
 *
 * `process.env` is a snapshot of the moment the server started. Installing
 * Claude Code or Codex afterwards often puts the binary in a folder that was
 * not on PATH then -- `~/.local/bin`, `~/.claude/local`, a fresh npm prefix --
 * and adds that folder to the user's shell profile, which only a new login
 * shell reads. So: ask a login shell what PATH is now, add the folders the
 * installers use, and fold both into `process.env.PATH`. Every provider probe
 * and every new terminal inherits it from there (`terminalEnv`).
 */

const MARK = "\x1fUCCH_PATH";
const END = "\x1f";

/** Where the CLI installers put their binaries, relative to home or absolute. */
export const INSTALL_DIRS = [
  "~/.local/bin",
  "~/.claude/local",
  "~/.npm-global/bin",
  "~/.bun/bin",
  "~/.volta/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
] as const;

/**
 * The PATH between the markers. rc files may print a greeting, a motd or
 * escape codes around it; only what the markers fence counts.
 */
export function parseMarkedPath(stdout: string): string | null {
  const start = stdout.indexOf(MARK);
  if (start < 0) return null;
  const end = stdout.indexOf(END, start + MARK.length);
  if (end < 0) return null;
  const path = stdout.slice(start + MARK.length, end).trim();
  return path || null;
}

/**
 * The current entries first, so nothing that resolves today resolves to
 * something else after a refresh; then whatever the login shell adds; then
 * the installers' folders that exist. No duplicates, no empty entries.
 */
export function mergePath(
  current: string | undefined,
  login: string | null,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const out: string[] = [];
  const add = (entry: string) => {
    if (entry && !out.includes(entry)) out.push(entry);
  };
  for (const entry of (current ?? "").split(delimiter)) add(entry);
  for (const entry of (login ?? "").split(delimiter)) add(entry);
  for (const dir of INSTALL_DIRS) {
    const path = dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
    if (exists(path)) add(path);
  }
  return out.join(delimiter);
}

/** The PATH a fresh login shell would have, or null when that cannot be told. */
export function readLoginPath(shell: string = loginShell(), timeoutMs = 5_000): Promise<string | null> {
  const script =
    basename(shell) === "fish"
      ? `printf '%s%s%s' '${MARK}' (string join : $PATH) '${END}'`
      : `printf '%s%s%s' '${MARK}' "$PATH" '${END}'`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-l", "-c", script],
      { timeout: timeoutMs, env: { ...process.env, TERM: "dumb" }, maxBuffer: 1024 * 1024 },
      (_error, stdout) => resolve(parseMarkedPath(String(stdout ?? ""))),
    );
  });
}

/** Folds a login shell's PATH and the install folders into `process.env.PATH`. */
export async function refreshHostPath(): Promise<string> {
  const login = await readLoginPath().catch(() => null);
  const merged = mergePath(process.env.PATH, login, process.env.HOME || homedir());
  process.env.PATH = merged;
  return merged;
}
