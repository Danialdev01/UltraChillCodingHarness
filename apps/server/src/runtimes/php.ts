import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { downloadTo } from "./download.js";
import type { InstallContext, RuntimeProvider, RuntimeRelease } from "./types.js";

const run = promisify(execFile);

/**
 * PHP, as the static builds static-php-cli publishes: one self-contained
 * `php` binary per version, no shared libraries, no ini file, nothing to
 * compile -- so a server that is not root can install any version into a
 * folder of its own.
 *
 * The "common" extension set: bcmath, ctype, curl, dom, exif, fileinfo,
 * filter, gd, gmp, iconv, mbstring, openssl, pcntl, pdo_mysql, pdo_pgsql,
 * pdo_sqlite, pgsql, phar, posix, redis, session, simplexml, soap, sockets,
 * sqlite3, tokenizer, xml*, zip, zlib. Everything Laravel asks for. Not
 * intl (the "bulk" set has it, but lacks pdo_sqlite and pdo_pgsql, which
 * matter more). A project that needs intl uses `system`.
 *
 * The index publishes no checksums, so a download is trusted on TLS alone;
 * what is checked is that the binary runs and reports the version asked for.
 */
const BASE = "https://dl.static-php.dev/static-php-cli/common/";

/** Generous: the builds are 7-13 MB compressed. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const MAX_COMPOSER_JSON_BYTES = 1024 * 1024;

/** `linux-x86_64` for this machine, or null where no build is published. */
export function phpPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** The CLI builds an index listing offers for `platform`, by version. */
export function parsePhpIndex(entries: unknown, platform: string): RuntimeRelease[] {
  if (!Array.isArray(entries)) throw new Error("the PHP download index is not a list");
  const pattern = new RegExp(`^php-(\\d+\\.\\d+\\.\\d+)-cli-${platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tar\\.gz$`);
  const releases: RuntimeRelease[] = [];
  for (const entry of entries) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name !== "string") continue;
    const match = pattern.exec(name);
    if (match?.[1]) releases.push({ version: match[1], url: new URL(name, BASE).toString() });
  }
  return releases;
}

export function createPhpProvider(): RuntimeProvider {
  return {
    id: "php",
    binaries: ["php"],

    async listAvailable(signal) {
      const platform = phpPlatform();
      if (!platform) throw new Error(`no prebuilt PHP is published for ${process.platform}/${process.arch}`);
      const response = await fetch(`${BASE}?format=json`, { signal: signal ?? AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`the PHP download index answered HTTP ${response.status}`);
      return parsePhpIndex(await response.json(), platform);
    },

    async install(release: RuntimeRelease, dir: string, context: InstallContext) {
      const bin = join(dir, "bin");
      await mkdir(bin, { recursive: true });
      const archive = join(dir, "php.tar.gz");
      await downloadTo(release.url, archive, { maxBytes: MAX_DOWNLOAD_BYTES, ...context });
      // Only the one member: an archive that held anything else, or held
      // `php` as a link, does not get to put it anywhere.
      await run("tar", ["-xzf", archive, "-C", bin, "--no-same-owner", "--no-same-permissions", "php"], {
        timeout: 120_000,
        signal: context.signal,
      });
      await rm(archive, { force: true });
      const php = join(bin, "php");
      const info = await lstat(php);
      if (!info.isFile()) throw new Error("the PHP archive's php is not a regular file");
      await chmod(php, 0o755);
      const reported = await this.versionOf(php);
      if (reported !== release.version) {
        throw new Error(`the downloaded PHP reports ${reported ?? "nothing"}, not ${release.version}`);
      }
    },

    async versionOf(bin: string) {
      try {
        // `-n`: no php.ini, so a system one cannot change what is reported.
        const { stdout } = await run(bin, ["-n", "-r", "echo PHP_VERSION;"], {
          timeout: 10_000,
          env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        });
        return /^\d+\.\d+\.\d+/.exec(stdout.trim())?.[0] ?? null;
      } catch {
        return null;
      }
    },

    constraintOf(root: string) {
      const file = join(root, "composer.json");
      try {
        const info = lstatSync(file);
        if (!info.isFile() || info.size > MAX_COMPOSER_JSON_BYTES) return null;
        const json = JSON.parse(readFileSync(file, "utf8")) as { require?: Record<string, unknown> };
        const php = json.require?.php;
        return typeof php === "string" && php.trim() ? php.trim().slice(0, 200) : null;
      } catch {
        return null;
      }
    },
  };
}
