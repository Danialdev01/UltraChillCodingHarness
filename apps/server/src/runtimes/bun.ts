import { chmod, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { parseShasums, verifyDigest } from "./checksum.js";
import { downloadTo } from "./download.js";
import { fetchJson, fetchText, linuxArch, probeEnv, readProjectFile, run } from "./shared.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

/**
 * Bun, as the zips GitHub releases publish, each checked against the
 * release's `SHASUMS256.txt`. `bunx` is bun under another name.
 */
const RELEASES = "https://api.github.com/repos/oven-sh/bun/releases?per_page=40";
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export function bunAsset(arch: "x64" | "arm64"): string {
  return arch === "x64" ? "bun-linux-x64.zip" : "bun-linux-aarch64.zip";
}

interface GithubRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: { name?: unknown; browser_download_url?: unknown }[];
}

/** The releases with a zip for this machine, with where their checksums are (in `url`'s sibling). */
export function parseBunReleases(entries: unknown, arch: "x64" | "arm64"): RuntimeRelease[] {
  if (!Array.isArray(entries)) throw new Error("the Bun release list is not a list");
  const asset = bunAsset(arch);
  const releases: RuntimeRelease[] = [];
  for (const entry of entries as GithubRelease[]) {
    const match = typeof entry.tag_name === "string" ? /^bun-v(\d+\.\d+\.\d+)$/.exec(entry.tag_name) : null;
    if (!match || entry.prerelease || entry.draft) continue;
    const zip = entry.assets?.find((a) => a.name === asset);
    if (typeof zip?.browser_download_url !== "string") continue;
    releases.push({ version: match[1]!, url: zip.browser_download_url });
  }
  return releases;
}

export function createBunProvider(): RuntimeProvider {
  return {
    id: "bun",
    binaries: ["bun", "bunx"],

    async listAvailable(signal) {
      const arch = linuxArch();
      if (!arch) throw new Error(`no Bun build is used for ${process.platform}/${process.arch}`);
      return parseBunReleases(await fetchJson(RELEASES, signal), arch);
    },

    async install(release, dir, context) {
      const name = release.url.slice(release.url.lastIndexOf("/") + 1);
      const sums = parseShasums(await fetchText(new URL("SHASUMS256.txt", release.url).toString(), context.signal));
      const sha256 = sums.get(name);
      if (!sha256) throw new Error(`SHASUMS256.txt does not list ${name}`);
      const archive = join(dir, "bun.zip");
      await downloadTo(release.url, archive, { maxBytes: MAX_DOWNLOAD_BYTES, ...context });
      await verifyDigest(archive, { sha256 });
      const folder = name.replace(/\.zip$/, "");
      // Only the one member, junked into bin/.
      await run("unzip", ["-q", "-j", "-o", archive, `${folder}/bun`, "-d", join(dir, "bin")], { timeout: 120_000, signal: context.signal });
      await rm(archive, { force: true });
      const bun = join(dir, "bin", "bun");
      if (!(await lstat(bun)).isFile()) throw new Error("the Bun archive's bun is not a regular file");
      await chmod(bun, 0o755);
      await symlink("bun", join(dir, "bin", "bunx"));
      const reported = await this.versionOf(bun);
      if (reported !== release.version) throw new Error(`the downloaded Bun reports ${reported ?? "nothing"}, not ${release.version}`);
    },

    async versionOf(bin) {
      try {
        const { stdout } = await run(bin, ["--version"], { timeout: 10_000, env: probeEnv() });
        return /^(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1] ?? null;
      } catch {
        return null;
      }
    },

    constraintOf(root) {
      const pkg = readProjectFile(root, "package.json");
      if (!pkg) return null;
      try {
        const json = JSON.parse(pkg) as { engines?: { bun?: unknown }; packageManager?: unknown };
        if (typeof json.engines?.bun === "string") return json.engines.bun.trim().slice(0, 200);
        const pm = typeof json.packageManager === "string" ? /^bun@(\d+\.\d+\.\d+)/.exec(json.packageManager) : null;
        return pm?.[1] ?? null;
      } catch {
        return null;
      }
    },
    selectionFor: (constraint) => (/^\d+\.\d+\.\d+$/.test(constraint) ? constraint : null),
  };
}
