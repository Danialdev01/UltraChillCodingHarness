import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptValue,
  initVault,
  newVar,
  readVault,
  rekeyVault,
  UnreadableVault,
  unlockVault,
  WrongProjectKey,
  writeVault,
} from "./env-vault.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ucch-vault-"));
  await mkdir(join(dir, ".agent"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("env.val", () => {
  it("round-trips a value through the file and keeps no plaintext in it", async () => {
    const { vault, key } = await initVault("correct horse");
    vault.vars.push(newVar({ name: "STRIPE_KEY", value: "sk_live_123", tags: ["billing"] }, key));
    await writeVault(dir, vault);

    const text = await readFile(join(dir, ".agent", "env.val"), "utf8");
    expect(text).toContain("STRIPE_KEY");
    expect(text).not.toContain("sk_live_123");
    expect(text).not.toContain("correct horse");

    const read = (await readVault(dir))!;
    const again = await unlockVault(read, "correct horse");
    expect(decryptValue(read.vars[0]!, again)).toBe("sk_live_123");
  });

  it("refuses a wrong project key", async () => {
    const { vault } = await initVault("correct horse");
    await expect(unlockVault(vault, "wrong horse")).rejects.toBeInstanceOf(WrongProjectKey);
  });

  it("re-encrypts every value under a new key, and the old one stops working", async () => {
    const { vault, key } = await initVault("old-key-123");
    vault.vars.push(newVar({ name: "A", value: "one" }, key), newVar({ name: "B", value: "two" }, key));
    const next = await rekeyVault(vault, key, "new-key-456");
    await expect(unlockVault(next, "old-key-123")).rejects.toBeInstanceOf(WrongProjectKey);
    const fresh = await unlockVault(next, "new-key-456");
    expect(next.vars.map((v) => decryptValue(v, fresh))).toEqual(["one", "two"]);
    expect(next.vars.map((v) => v.id)).toEqual(vault.vars.map((v) => v.id));
  });

  it("says a tampered value is unreadable rather than returning garbage", async () => {
    const { vault, key } = await initVault("correct horse");
    const variable = newVar({ name: "A", value: "one" }, key);
    const [iv, tag] = variable.value.split(".");
    variable.value = [iv, tag, Buffer.from("other").toString("base64url")].join(".");
    expect(() => decryptValue(variable, key)).toThrow(UnreadableVault);
  });

  it("is null when absent and refuses a symlink or a file that is not a vault", async () => {
    expect(await readVault(dir)).toBeNull();
    await writeFile(join(dir, ".agent", "env.val"), JSON.stringify({ version: 1, kdf: { name: "scrypt", salt: "x", N: 2 ** 30, r: 8, p: 1 }, check: "", vars: [] }));
    await expect(readVault(dir)).rejects.toBeInstanceOf(UnreadableVault);
    await rm(join(dir, ".agent", "env.val"));
    await symlink("/etc/passwd", join(dir, ".agent", "env.val"));
    await expect(readVault(dir)).rejects.toBeInstanceOf(UnreadableVault);
  });
});
