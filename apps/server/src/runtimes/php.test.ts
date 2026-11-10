import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPhpProvider, parsePhpIndex, phpPlatform } from "./php.js";

describe("php provider", () => {
  it("names the build for this machine", () => {
    expect(phpPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(phpPlatform("darwin", "arm64")).toBe("macos-aarch64");
    expect(phpPlatform("win32", "x64")).toBeNull();
  });

  it("reads the CLI builds for one platform out of the index", () => {
    const index = [
      { name: "license/", is_dir: true },
      { name: "php-8.4.12-cli-linux-x86_64.tar.gz" },
      { name: "php-8.4.12-fpm-linux-x86_64.tar.gz" },
      { name: "php-8.4.12-cli-linux-aarch64.tar.gz" },
      { name: "php-8.5.0RC1-cli-linux-x86_64.tar.gz" },
      { name: "php-8.3.30-cli-linux-x86_64.tar.gz" },
    ];
    expect(parsePhpIndex(index, "linux-x86_64")).toEqual([
      { version: "8.4.12", url: "https://dl.static-php.dev/static-php-cli/common/php-8.4.12-cli-linux-x86_64.tar.gz" },
      { version: "8.3.30", url: "https://dl.static-php.dev/static-php-cli/common/php-8.3.30-cli-linux-x86_64.tar.gz" },
    ]);
    expect(() => parsePhpIndex({}, "linux-x86_64")).toThrow();
  });

  it("reads composer.json's require.php", () => {
    const dir = mkdtempSync(join(tmpdir(), "ucch-php-"));
    const php = createPhpProvider();
    expect(php.constraintOf?.(dir)).toBeNull();
    writeFileSync(join(dir, "composer.json"), JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11" } }));
    expect(php.constraintOf?.(dir)).toBe("^8.2");
    writeFileSync(join(dir, "composer.json"), "{ not json");
    expect(php.constraintOf?.(dir)).toBeNull();
  });
});
