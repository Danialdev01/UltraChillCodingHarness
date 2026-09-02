import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

describe("secret encryption", () => {
  it("round-trips", () => {
    const secret = "ghp_exampletoken1234567890";
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different ciphertext each time", () => {
    // A deterministic ciphertext would leak that two projects share a value.
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("fails closed on a wrong key", () => {
    const encoded = encryptSecret("secret", KEY);
    expect(() => decryptSecret(encoded, OTHER_KEY)).toThrow();
  });

  it("fails closed on tampered ciphertext", () => {
    const [iv, tag, body] = encryptSecret("secret", KEY).split(".");
    const flipped = Buffer.from(body!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = [iv, tag, flipped.toString("base64url")].join(".");
    // GCM authenticates, so this throws rather than returning garbage.
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it("rejects a malformed key", () => {
    expect(() => encryptSecret("x", "tooshort")).toThrow(/32 bytes/);
  });

  it("handles unicode and empty values", () => {
    expect(decryptSecret(encryptSecret("", KEY), KEY)).toBe("");
    expect(decryptSecret(encryptSecret("héllo 🌍", KEY), KEY)).toBe("héllo 🌍");
  });
});
