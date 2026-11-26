import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { verifyDigest, parseShasums } from "./checksum.js";
import { downloadTo } from "./download.js";
import { fetchJson, fetchText, linuxArch, probeEnv, readProjectFile, run } from "./shared.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

/**
 * Node.js, from nodejs.org's own tarballs: `index.json` lists every
 * release (and which are LTS), and each release's `SHASUMS256.txt` is
 * checked before anything is unpacked. `corepack enable` puts pnpm and yarn
 * shims beside node, so a project's package manager follows its Node.
 */
const DIST = "https://nodejs.org/dist/";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const COREPACK_FALLBACK: [string, string][] = [
  ["corepack", "corepack"],
  ["pnpm", "pnpm"],
  ["pnpx", "pnpm dlx"],
  ["yarn", "yarn"],
  ["yarnpkg", "yarn"],
];

export const NODE_BINARIES = ["node", "npm", "npx", "corepack", "pnpm", "pnpx", "yarn", "yarnpkg"] as const;

/** The releases built for `linux-{arch}`, LTS ones tagged. Pre-releases are left out. */
export function parseNodeIndex(entries: unknown, arch: "x64" | "arm64"): RuntimeRelease[] {
  if (!Array.isArray(entries)) throw new Error("the Node.js index is not a list");
  const releases: RuntimeRelease[] = [];
  for (const entry of entries as { version?: unknown; files?: unknown; lts?: unknown }[]) {
    const match = typeof entry?.version === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(entry.version) : null;
    if (!match || !Array.isArray(entry.files) || !entry.files.includes(`linux-${arch}`)) continue;
    const version = match[1]!;
    releases.push({
      version,
      url: `${DIST}v${version}/node-v${version}-linux-${arch}.tar.xz`,
      ...(entry.lts ? { tags: ["lts"] } : {}),
    });
  }
  return releases;
}

/** `package.json`'s `engines.node`, else `.nvmrc` / `.node-version`. */
export function nodeConstraint(root: string): string | null {
  const pkg = readProjectFile(root, "package.json");
  if (pkg) {
    try {
      const engines = (JSON.parse(pkg) as { engines?: { node?: unknown } }).engines;
      if (typeof engines?.node === "string" && engines.node.trim()) return engines.node.trim().slice(0, 200);
    } catch {
      // Not JSON: the other files may still say.
    }
  }
  for (const name of [".nvmrc", ".node-version"]) {
    const text = readProjectFile(root, name, 1024)?.trim().replace(/^v/, "");
    if (text) return text.split(/\s/)[0]!.slice(0, 40);
  }
  return null;
}

export function createNodeProvider(): RuntimeProvider {
  return {
    id: "node",
    binaries: NODE_BINARIES,

    async listAvailable(signal) {
      const arch = linuxArch();
      if (!arch) throw new Error(`no Node.js build is used for ${process.platform}/${process.arch}`);
      return parseNodeIndex(await fetchJson(`${DIST}index.json`, signal), arch);
    },

    async install(release, dir, context) {
      const archive = join(dir, "node.tar.xz");
      const name = release.url.slice(release.url.lastIndexOf("/") + 1);
      const sums = parseShasums(await fetchText(new URL("SHASUMS256.txt", release.url).toString(), context.signal));
      const sha256 = sums.get(name);
      if (!sha256) throw new Error(`SHASUMS256.txt does not list ${name}`);
      await downloadTo(release.url, archive, { maxBytes: MAX_DOWNLOAD_BYTES, ...context });
      await verifyDigest(archive, { sha256 });
      await run("tar", ["-xJf", archive, "-C", dir, "--strip-components=1", "--no-same-owner"], { timeout: 180_000, signal: context.signal });
      await rm(archive, { force: true });
      // pnpm and yarn as corepack shims beside node; the package manager
      // itself is fetched on first use into the workspace's COREPACK_HOME.
      const bin = join(dir, "bin");
      await run(join(bin, "corepack"), ["enable", "--install-directory", bin, "pnpm", "yarn"], {
        timeout: 60_000,
        env: probeEnv({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }),
      }).catch(async () => {
        // Node 25 and later ship without corepack: small scripts that run
        // the package manager through npx instead, cached per workspace.
        for (const [shim, line] of COREPACK_FALLBACK) {
          const at = join(bin, shim);
          if (await lstat(at).catch(() => null)) continue;
          await writeFile(at, `#!/bin/sh\nexec "$(dirname "$0")/npx" --yes ${line} "$@"\n`, { mode: 0o755 });
        }
      });
      await mkdir(bin, { recursive: true });
      const reported = await this.versionOf(join(bin, "node"));
      if (reported !== release.version) throw new Error(`the downloaded Node.js reports ${reported ?? "nothing"}, not ${release.version}`);
    },

    async versionOf(bin) {
      try {
        const { stdout } = await run(bin, ["--version"], { timeout: 10_000, env: probeEnv() });
        return /^v?(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1] ?? null;
      } catch {
        return null;
      }
    },

    constraintOf: nodeConstraint,
    selectionFor: (constraint) => (/^\d+(\.\d+){0,2}$/.test(constraint) ? constraint : /^lts\//i.test(constraint) ? "lts" : null),
  };
}
