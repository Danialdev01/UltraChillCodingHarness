import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

/** A small file of a checkout, as text; null when absent, a link, a folder or too large. */
export function readProjectFile(root: string, name: string, maxBytes = 1024 * 1024): string | null {
  const file = join(root, name);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `x64` or `arm64` for Linux on those CPUs; null elsewhere, where nothing is published that we use. */
export function linuxArch(platform: NodeJS.Platform = process.platform, arch: string = process.arch): "x64" | "arm64" | null {
  if (platform !== "linux") return null;
  return arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
}

/** What a version check runs with: PATH and a fixed locale, nothing of the server's own config. */
export function probeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME ?? "/tmp", ...extra };
}

export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.text();
}
