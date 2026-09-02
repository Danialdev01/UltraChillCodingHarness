import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("danialdev");
    expect(await verifyPassword("danialdev", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("danialdev");
    expect(await verifyPassword("danialdeV", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts, so identical passwords hash differently", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("records its cost parameters in the encoding", async () => {
    // Stored parameters are what allow the work factor to be raised later
    // without invalidating existing hashes.
    const [algorithm, n, r, p] = (await hashPassword("x")).split("$");
    expect(algorithm).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(16384);
    expect([r, p]).toEqual(["8", "1"]);
  });

  it("returns false for a missing or malformed hash instead of throwing", async () => {
    // A corrupt stored hash must fail the login, not crash the request.
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword("x", "scrypt$a$b$c$d$e")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$c2FsdA$")).toBe(false);
  });

  it("handles unicode and long passwords", async () => {
    const long = "🔐".repeat(100);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });
});
