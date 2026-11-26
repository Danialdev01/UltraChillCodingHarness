import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { verifyDigest } from "./checksum.js";
import { downloadTo } from "./download.js";
import { fetchJson, fetchText, probeEnv, run } from "./shared.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

/**
 * Composer, the phar getcomposer.org publishes per version, checked against
 * its `.sha256sum`. `bin/composer` is the phar itself: `#!/usr/bin/env php`,
 * so it runs on whatever PHP the project has linked.
 */
const BASE = "https://getcomposer.org";
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** `versions`' channels: stable, and the 2.2 LTS line, tagged. */
export function parseComposerVersions(json: unknown): RuntimeRelease[] {
  const channels = (json ?? {}) as Record<string, { path?: unknown; version?: unknown; lts?: unknown }[]>;
  const releases = new Map<string, RuntimeRelease>();
  for (const channel of ["stable", "2", "2.2"]) {
    for (const entry of channels[channel] ?? []) {
      if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.version) || typeof entry.path !== "string") continue;
      const lts = entry.lts === true || entry.version.startsWith("2.2.");
      releases.set(entry.version, { version: entry.version, url: new URL(entry.path, BASE).toString(), ...(lts ? { tags: ["lts"] } : {}) });
    }
  }
  if (releases.size === 0) throw new Error("getcomposer.org listed no stable Composer");
  return [...releases.values()];
}

export function createComposerProvider(): RuntimeProvider {
  return {
    id: "composer",
    binaries: ["composer"],

    async listAvailable(signal) {
      return parseComposerVersions(await fetchJson(`${BASE}/versions`, signal));
    },

    async install(release, dir, context) {
      const sum = (await fetchText(`${release.url}.sha256sum`, context.signal)).trim().split(/\s+/)[0] ?? "";
      if (!/^[0-9a-f]{64}$/i.test(sum)) throw new Error("getcomposer.org published no checksum for this version");
      await mkdir(join(dir, "bin"), { recursive: true });
      const phar = join(dir, "bin", "composer");
      await downloadTo(release.url, phar, { maxBytes: MAX_DOWNLOAD_BYTES, ...context });
      await verifyDigest(phar, { sha256: sum });
      await chmod(phar, 0o755);
      const reported = await this.versionOf(phar);
      // No PHP on this server at all is not the phar's fault: the checksum stands.
      if (reported !== null && reported !== release.version) throw new Error(`the downloaded Composer reports ${reported}, not ${release.version}`);
    },

    async versionOf(bin) {
      try {
        const { stdout } = await run(bin, ["--version", "--no-ansi", "--no-plugins"], { timeout: 15_000, env: probeEnv({ COMPOSER_ALLOW_SUPERUSER: "1" }) });
        return /Composer (?:version )?(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
      } catch {
        return null;
      }
    },
  };
}
