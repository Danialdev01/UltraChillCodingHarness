import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bunAsset, parseBunReleases } from "./bun.js";
import { parseShasums, verifyDigest } from "./checksum.js";
import { parseComposerVersions } from "./composer.js";
import { dotnetConstraint, parseDotnetIndex, parseDotnetReleases } from "./dotnet.js";
import { nodeConstraint, parseNodeIndex } from "./node.js";
import { parseRustChannel, rustConstraint, rustSelectionFor } from "./rust.js";
import { compareVersions, matchesSelection, newestFirst, pickVersion } from "./version.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ucch-rt-"));

describe("version selections for the new runtimes (plan3 §2.4)", () => {
  const rust = ["1.100.0", "1.99.1", "1.101.0-beta.3", "1.102.0-nightly.20261125", "1.102.0-nightly.20261120"];
  it("orders a pre-release below its release and nightlies by date", () => {
    expect(newestFirst(rust)).toEqual(["1.102.0-nightly.20261125", "1.102.0-nightly.20261120", "1.101.0-beta.3", "1.100.0", "1.99.1"]);
    expect(compareVersions("1.100.0", "1.100.0-beta.1")).toBeGreaterThan(0);
  });
  it("picks by channel, and a major, and lts by tag", () => {
    expect(pickVersion("stable", rust)).toBe("1.100.0");
    expect(pickVersion("latest", rust)).toBe("1.100.0");
    expect(pickVersion("beta", rust)).toBe("1.101.0-beta.3");
    expect(pickVersion("nightly", rust)).toBe("1.102.0-nightly.20261125");
    expect(pickVersion("22", ["24.1.0", "22.9.0", "22.10.1"])).toBe("22.10.1");
    const lts = (v: string) => (v.startsWith("24.") ? ["lts"] : []);
    expect(pickVersion("lts", ["26.1.0", "24.3.0", "24.2.0"], lts)).toBe("24.3.0");
    expect(matchesSelection("1.100", "1.100.0-beta.1")).toBe(false);
  });
});

describe("node", () => {
  it("reads the index: releases for this machine, LTS tagged, pre-releases left out", () => {
    const index = [
      { version: "v27.0.0-alpha.0", files: ["linux-x64"], lts: false },
      { version: "v26.13.1", files: ["linux-x64", "linux-arm64"], lts: "Lithium" },
      { version: "v26.12.0", files: ["linux-arm64"], lts: false },
    ];
    expect(parseNodeIndex(index, "x64")).toEqual([
      { version: "26.13.1", url: "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz", tags: ["lts"] },
    ]);
    expect(() => parseNodeIndex({}, "x64")).toThrow();
  });
  it("reads engines.node, then .nvmrc", () => {
    const dir = tmp();
    expect(nodeConstraint(dir)).toBeNull();
    writeFileSync(join(dir, ".nvmrc"), "v22\n");
    expect(nodeConstraint(dir)).toBe("22");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=20" } }));
    expect(nodeConstraint(dir)).toBe(">=20");
  });
});

describe("bun", () => {
  it("keeps releases that have this machine's zip", () => {
    const releases = [
      { tag_name: "bun-v1.4.5", assets: [{ name: bunAsset("x64"), browser_download_url: "https://x/bun-linux-x64.zip" }] },
      { tag_name: "bun-v1.5.0", prerelease: true, assets: [{ name: bunAsset("x64"), browser_download_url: "https://x/y.zip" }] },
      { tag_name: "canary", assets: [] },
    ];
    expect(parseBunReleases(releases, "x64")).toEqual([{ version: "1.4.5", url: "https://x/bun-linux-x64.zip" }]);
  });
});

describe("composer", () => {
  it("lists stable and the LTS line", () => {
    const json = {
      stable: [{ path: "/download/2.11.3/composer.phar", version: "2.11.3" }],
      "2.2": [{ path: "/download/2.2.33/composer.phar", version: "2.2.33", lts: true }],
    };
    expect(parseComposerVersions(json)).toEqual([
      { version: "2.11.3", url: "https://getcomposer.org/download/2.11.3/composer.phar" },
      { version: "2.2.33", url: "https://getcomposer.org/download/2.2.33/composer.phar", tags: ["lts"] },
    ]);
  });
});

describe("dotnet", () => {
  it("lists supported channels and their SDKs with sha512", () => {
    const index = {
      "releases-index": [
        { "channel-version": "11.0", "releases.json": "https://x/11.json", "support-phase": "active", "release-type": "sts" },
        { "channel-version": "10.0", "releases.json": "https://x/10.json", "support-phase": "active", "release-type": "lts" },
        { "channel-version": "12.0", "releases.json": "https://x/12.json", "support-phase": "preview", "release-type": "lts" },
        { "channel-version": "6.0", "releases.json": "https://x/6.json", "support-phase": "eol", "release-type": "lts" },
      ],
    };
    expect(parseDotnetIndex(index)).toEqual([
      { channel: "11.0", url: "https://x/11.json", lts: false },
      { channel: "10.0", url: "https://x/10.json", lts: true },
    ]);
    const releases = {
      releases: [
        {
          sdks: [
            { version: "10.0.404", files: [{ name: "dotnet-sdk-linux-x64.tar.gz", rid: "linux-x64", url: "https://x/sdk.tgz", hash: "ab" }] },
            { version: "10.0.300", files: [{ name: "dotnet-sdk-linux-x64.zip", rid: "linux-x64", url: "https://x/sdk.zip", hash: "cd" }] },
          ],
        },
      ],
    };
    expect(parseDotnetReleases(releases, "x64", true)).toEqual([{ version: "10.0.404", url: "https://x/sdk.tgz", sha512: "ab", tags: ["lts"] }]);
  });
  it("reads global.json", () => {
    const dir = tmp();
    writeFileSync(join(dir, "global.json"), JSON.stringify({ sdk: { version: "9.0.100", rollForward: "latestFeature" } }));
    expect(dotnetConstraint(dir)).toBe("9.0.100");
  });
});

describe("rust", () => {
  it("reads a channel manifest's version and the dated toolchain", () => {
    const manifest = (v: string) => `manifest-version = "2"\n[pkg.rust]\nversion = "${v}"\ngit_commit_hash = "x"\n`;
    expect(parseRustChannel(manifest("1.100.0 (0ef1bc386 2026-11-09)"), "stable")).toEqual({ version: "1.100.0", url: "1.100.0" });
    expect(parseRustChannel(manifest("1.101.0-beta.3 (f47eed4a8 2026-11-22)"), "beta")).toEqual({ version: "1.101.0-beta.3", url: "beta-2026-11-22" });
    expect(parseRustChannel(manifest("1.102.0-nightly (6c709eb42 2026-11-25)"), "nightly")).toEqual({
      version: "1.102.0-nightly.20261125",
      url: "nightly-2026-11-25",
    });
    expect(() => parseRustChannel("nothing", "stable")).toThrow();
  });
  it("reads rust-toolchain.toml and says which selections it means", () => {
    const dir = tmp();
    writeFileSync(join(dir, "rust-toolchain.toml"), '[toolchain]\nchannel = "nightly"\ncomponents = ["rustfmt"]\n');
    expect(rustConstraint(dir)).toBe("nightly");
    expect(rustSelectionFor("nightly")).toBe("nightly");
    expect(rustSelectionFor("1.85.0")).toBe("1.85.0");
    expect(rustSelectionFor("nightly-2026-01-01")).toBeNull();
  });
  it("does not read a symlinked toolchain file", () => {
    const dir = tmp();
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "t.toml"), 'channel = "beta"\n');
    symlinkSync(join(dir, "elsewhere", "t.toml"), join(dir, "rust-toolchain.toml"));
    expect(rustConstraint(dir)).toBeNull();
  });
});

describe("checksums", () => {
  it("reads SHASUMS256.txt and refuses a mismatch", async () => {
    const sums = parseShasums(`${"a".repeat(64)}  node-v1.tar.xz\n${"b".repeat(64)} *./rustup-init\n`);
    expect(sums.get("node-v1.tar.xz")).toBe("a".repeat(64));
    expect(sums.get("rustup-init")).toBe("b".repeat(64));
    const file = join(tmp(), "f");
    writeFileSync(file, "hello");
    await expect(verifyDigest(file, { sha256: "0".repeat(64) })).rejects.toThrow(/sha256/);
    await expect(verifyDigest(file, { sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" })).resolves.toBeUndefined();
  });
});
