import { readlinkSync } from "node:fs";
import { mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";

import { verifyDigest } from "./checksum.js";
import { downloadTo } from "./download.js";
import { fetchText, linuxArch, probeEnv, readProjectFile, run } from "./shared.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

/**
 * Rust, through rustup, with everything under the runtimes root:
 *
 *   rust/.rustup                     RUSTUP_HOME: one toolchain folder per install
 *   rust/.cargo/bin/rustup           rustup itself, installed once, pinned
 *   rust/1.100.0/bin/cargo  -> ../../.rustup/toolchains/1.100.0-<triple>/bin/cargo
 *   rust/1.101.0-beta.3/bin/…        a beta, by its dated toolchain
 *
 * A version is what the toolchain's rustc reports, so channels order like
 * any other runtime and `stable`, `beta` and `nightly` are selections. The
 * links go straight to the toolchain's binaries, not rustup's proxies, so a
 * project's toolchain is the one its `runtimes.json` names; `rustup` itself
 * is linked too, with RUSTUP_TOOLCHAIN set for that project
 * (`processEnv`), so `rustup component add` acts on the same toolchain.
 */
const DIST = "https://static.rust-lang.org";
export const RUSTUP_VERSION = "1.29.3";
/** rustup-init's sha256, pinned for the image's machine; others read the published `.sha256`. */
const RUSTUP_SHA256: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55",
};
const MAX_RUSTUP_BYTES = 40 * 1024 * 1024;

export const RUST_BINARIES = ["cargo", "rustc", "rustdoc", "rustup", "cargo-clippy", "clippy-driver", "rustfmt", "cargo-fmt"] as const;

export function rustTriple(arch: "x64" | "arm64"): string {
  return arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
}

/**
 * A channel manifest's `[pkg.rust] version = "1.101.0-beta.3 (f47eed4a8 2026-11-22)"`
 * as a release: the version, and the dated toolchain name rustup installs
 * (`1.100.0` for stable; `beta-2026-11-22`, `nightly-2026-11-25` for the others).
 */
export function parseRustChannel(manifest: string, channel: "stable" | "beta" | "nightly"): RuntimeRelease {
  const pkg = /\[pkg\.rust\][^[]*?version\s*=\s*"([^"]+)"/.exec(manifest)?.[1];
  const match = pkg ? /^(\d+\.\d+\.\d+)(-(?:beta\.\d+|nightly))?\s+\(\w+\s+(\d{4}-\d{2}-\d{2})\)/.exec(pkg) : null;
  if (!match) throw new Error(`the ${channel} channel's manifest names no rust version`);
  const [, numbers, tag, date] = match;
  if (channel === "stable") return { version: numbers!, url: numbers! };
  const version = channel === "nightly" ? `${numbers}-nightly.${date!.replaceAll("-", "")}` : `${numbers}${tag}`;
  return { version, url: `${channel}-${date}` };
}

/** `rust-toolchain.toml`'s `channel`, or the bare legacy `rust-toolchain` file. */
export function rustConstraint(root: string): string | null {
  const toml = readProjectFile(root, "rust-toolchain.toml", 64 * 1024);
  const channel = toml ? /^\s*channel\s*=\s*"([^"]+)"/m.exec(toml)?.[1] : readProjectFile(root, "rust-toolchain", 1024)?.trim().split(/\s/)[0];
  return channel ? channel.slice(0, 60) : null;
}

/** `stable`, `nightly`, `1.85.0`, `1.85`: what a selection can say. A dated nightly cannot. */
export function rustSelectionFor(constraint: string): string | null {
  if (/^(stable|beta|nightly)$/.test(constraint)) return constraint;
  if (/^\d+\.\d+(\.\d+)?$/.test(constraint)) return constraint;
  return null;
}

export function createRustProvider(root: string): RuntimeProvider {
  const base = join(root, "rust");
  const rustupHome = join(base, ".rustup");
  const cargoHome = join(base, ".cargo");
  const rustup = join(cargoHome, "bin", "rustup");
  const env = () => probeEnv({ RUSTUP_HOME: rustupHome, CARGO_HOME: cargoHome });

  /** rustup-init, once, with no default toolchain. */
  async function ensureRustup(signal?: AbortSignal): Promise<void> {
    if (await stat(rustup).catch(() => null)) return;
    const arch = linuxArch();
    if (!arch) throw new Error(`no Rust toolchain is used for ${process.platform}/${process.arch}`);
    const triple = rustTriple(arch);
    const url = `${DIST}/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init`;
    const sha256 = RUSTUP_SHA256[triple] ?? (await fetchText(`${url}.sha256`, signal)).trim().split(/\s+/)[0];
    // Named `rustup-init` exactly: rustup decides what it is from its own
    // file name, so it sits in a folder of its own instead of being renamed.
    const folder = join(base, `.rustup-init-${process.pid}`);
    await mkdir(folder, { recursive: true });
    const init = join(folder, "rustup-init");
    try {
      await downloadTo(url, init, { maxBytes: MAX_RUSTUP_BYTES, ...(signal ? { signal } : {}) });
      await verifyDigest(init, { sha256: sha256 ?? "" });
      await run("chmod", ["755", init]);
      await run(init, ["-y", "--no-modify-path", "--default-toolchain", "none", "--profile", "minimal"], {
        timeout: 180_000,
        env: env(),
        ...(signal ? { signal } : {}),
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  return {
    id: "rust",
    binaries: RUST_BINARIES,

    async listAvailable(signal) {
      const releases: RuntimeRelease[] = [];
      for (const channel of ["stable", "beta", "nightly"] as const) {
        releases.push(parseRustChannel(await fetchText(`${DIST}/dist/channel-rust-${channel}.toml`, signal), channel));
      }
      return releases;
    },

    async install(release, dir, context) {
      await ensureRustup(context.signal);
      const toolchain = release.url;
      await run(rustup, ["toolchain", "install", toolchain, "--profile", "minimal", "-c", "clippy", "-c", "rustfmt", "--no-self-update"], {
        timeout: 900_000,
        env: env(),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const arch = linuxArch()!;
      const folder = join(rustupHome, "toolchains", `${toolchain}-${rustTriple(arch)}`);
      const bin = join(dir, "bin");
      await mkdir(bin, { recursive: true });
      const present = new Set(await readdir(join(folder, "bin")));
      for (const name of RUST_BINARIES) {
        // Relative, through the version folder's parent: `dir` is renamed
        // into place beside its final name, so the link survives the rename.
        const target = name === "rustup" ? join(cargoHome, "bin", "rustup") : join(folder, "bin", name);
        if (name !== "rustup" && !present.has(name)) throw new Error(`the ${toolchain} toolchain has no ${name}`);
        await symlink(relative(join(base, "x", "bin"), target), join(bin, name));
      }
      const reported = await this.versionOf(join(bin, "rustc"));
      if (!reported || !release.version.startsWith(reported)) {
        throw new Error(`the installed toolchain reports ${reported ?? "nothing"}, not ${release.version}`);
      }
    },

    async versionOf(bin) {
      try {
        const { stdout } = await run(bin, ["--version"], { timeout: 15_000, env: env() });
        return /^(?:rustc|cargo) (\d+\.\d+\.\d+(?:-(?:beta\.\d+|nightly))?)/.exec(stdout.trim())?.[1] ?? null;
      } catch {
        return null;
      }
    },

    constraintOf: rustConstraint,
    selectionFor: rustSelectionFor,

    processEnv(dir) {
      // The toolchain the links point at, by name, for rustup's own commands.
      return { RUSTUP_HOME: rustupHome, ...toolchainOf(dir) };
    },

    async remove(version) {
      const name = toolchainOf(join(base, version)).RUSTUP_TOOLCHAIN;
      if (name) await rm(join(rustupHome, "toolchains", `${name}-${rustTriple(linuxArch() ?? "x64")}`), { recursive: true, force: true });
    },
  };
}

/** `{ RUSTUP_TOOLCHAIN: "1.100.0" }` for a version folder, read from its rustc link. */
function toolchainOf(dir: string): { RUSTUP_TOOLCHAIN?: string } {
  try {
    const name = /toolchains\/([^/]+)-(?:x86_64|aarch64)-unknown-linux-gnu\//.exec(readlinkSync(join(dir, "bin", "rustc")))?.[1];
    return name ? { RUSTUP_TOOLCHAIN: name } : {};
  } catch {
    return {};
  }
}
