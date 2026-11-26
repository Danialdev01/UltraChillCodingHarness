import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { verifyDigest } from "./checksum.js";
import { downloadTo } from "./download.js";
import { fetchJson, linuxArch, probeEnv, readProjectFile, run } from "./shared.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

/**
 * The .NET SDK, from Microsoft's release metadata: `releases-index.json`
 * names the channels, each channel's `releases.json` lists its SDKs with a
 * sha512 per file. A version here is an SDK version (`10.0.404`); the
 * selection `10` is the newest 10.x SDK, `lts` the newest of an LTS channel.
 *
 * The SDK unpacks whole into the version's folder; `bin/dotnet` links to the
 * muxer at its root, which finds its SDKs beside its real path.
 */
const INDEX = "https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json";
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

interface Channel {
  "channel-version"?: unknown;
  "releases.json"?: unknown;
  "support-phase"?: unknown;
  "release-type"?: unknown;
}

/** The channels worth listing: supported, not previews. */
export function parseDotnetIndex(json: unknown): { channel: string; url: string; lts: boolean }[] {
  const entries = (json as { "releases-index"?: Channel[] })?.["releases-index"];
  if (!Array.isArray(entries)) throw new Error("the .NET release index has no releases-index");
  return entries
    .filter((c) => typeof c["releases.json"] === "string" && (c["support-phase"] === "active" || c["support-phase"] === "maintenance"))
    .map((c) => ({ channel: String(c["channel-version"]), url: String(c["releases.json"]), lts: c["release-type"] === "lts" }));
}

interface SdkFile {
  name?: unknown;
  rid?: unknown;
  url?: unknown;
  hash?: unknown;
}

/** One channel's SDKs for `linux-{arch}`, with their sha512. */
export function parseDotnetReleases(json: unknown, arch: "x64" | "arm64", lts: boolean): RuntimeRelease[] {
  const releases = (json as { releases?: { sdks?: { version?: unknown; files?: SdkFile[] }[]; sdk?: { version?: unknown; files?: SdkFile[] } }[] })
    ?.releases;
  if (!Array.isArray(releases)) throw new Error("a .NET channel's releases.json has no releases");
  const out = new Map<string, RuntimeRelease>();
  for (const release of releases) {
    for (const sdk of [...(release.sdks ?? []), ...(release.sdk ? [release.sdk] : [])]) {
      if (typeof sdk.version !== "string" || !/^\d+\.\d+\.\d+$/.test(sdk.version)) continue;
      const file = sdk.files?.find((f) => f.rid === `linux-${arch}` && typeof f.name === "string" && f.name.endsWith(".tar.gz"));
      if (typeof file?.url !== "string" || typeof file.hash !== "string") continue;
      out.set(sdk.version, { version: sdk.version, url: file.url, sha512: file.hash, ...(lts ? { tags: ["lts"] } : {}) });
    }
  }
  return [...out.values()];
}

/** `global.json`'s `sdk.version`. */
export function dotnetConstraint(root: string): string | null {
  const text = readProjectFile(root, "global.json", 64 * 1024);
  if (!text) return null;
  try {
    const version = (JSON.parse(text) as { sdk?: { version?: unknown } }).sdk?.version;
    return typeof version === "string" && version.trim() ? version.trim().slice(0, 40) : null;
  } catch {
    return null;
  }
}

export function createDotnetProvider(): RuntimeProvider {
  return {
    id: "dotnet",
    binaries: ["dotnet"],

    async listAvailable(signal) {
      const arch = linuxArch();
      if (!arch) throw new Error(`no .NET SDK is used for ${process.platform}/${process.arch}`);
      const channels = parseDotnetIndex(await fetchJson(INDEX, signal));
      const lists = await Promise.all(
        channels.map(async (c) => parseDotnetReleases(await fetchJson(c.url, signal), arch, c.lts).filter((r) => r.version.startsWith(`${c.channel.split(".")[0]}.`))),
      );
      return lists.flat();
    },

    async install(release, dir, context) {
      if (!release.sha512) throw new Error("the .NET index gave no checksum for this SDK");
      const archive = join(dir, "sdk.tar.gz");
      await downloadTo(release.url, archive, { maxBytes: MAX_DOWNLOAD_BYTES, ...context });
      await verifyDigest(archive, { sha512: release.sha512 });
      await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner"], { timeout: 300_000, signal: context.signal });
      await rm(archive, { force: true });
      if (!(await lstat(join(dir, "dotnet"))).isFile()) throw new Error("the SDK archive has no dotnet at its root");
      await mkdir(join(dir, "bin"), { recursive: true });
      await symlink("../dotnet", join(dir, "bin", "dotnet"));
      const reported = await this.versionOf(join(dir, "bin", "dotnet"));
      if (reported !== release.version) throw new Error(`the downloaded SDK reports ${reported ?? "nothing"}, not ${release.version}`);
    },

    async versionOf(bin) {
      try {
        // From `/`, so no global.json around the server changes the answer.
        const { stdout } = await run(bin, ["--version"], {
          timeout: 20_000,
          cwd: "/",
          env: probeEnv({ DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" }),
        });
        return /^(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1] ?? null;
      } catch {
        return null;
      }
    },

    constraintOf: dotnetConstraint,
    selectionFor: (constraint) => (/^\d+\.\d+\.\d+$/.test(constraint) ? constraint : null),
    processEnv: (dir) => ({ DOTNET_ROOT: dir }),
  };
}
