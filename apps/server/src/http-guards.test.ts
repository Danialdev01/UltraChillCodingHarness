import { describe, expect, it } from "vitest";
import { originAllowed } from "./http-guards.js";

const allowed = new Set(["https://ucch.example.com"]);

describe("originAllowed", () => {
  it("lets reads and origin-less callers through", () => {
    expect(originAllowed("GET", "https://evil.example", allowed, false)).toBe(true);
    expect(originAllowed("POST", undefined, allowed, false)).toBe(true);
  });

  it("accepts the app's own origin", () => {
    expect(originAllowed("POST", "https://ucch.example.com", allowed, false)).toBe(true);
  });

  it("refuses a preview subdomain and other sites", () => {
    expect(originAllowed("POST", "https://p3000-abcdefghijkl.ucch.example.com", allowed, false)).toBe(false);
    expect(originAllowed("DELETE", "https://evil.example", allowed, false)).toBe(false);
    expect(originAllowed("POST", "null", allowed, false)).toBe(false);
  });

  it("allows loopback only when asked", () => {
    expect(originAllowed("POST", "http://localhost:3000", allowed, true)).toBe(true);
    expect(originAllowed("POST", "http://127.0.0.1:3000", allowed, false)).toBe(false);
    expect(originAllowed("POST", "http://p3000-abcdefghijkl.ucch.localhost:3000", allowed, true)).toBe(false);
  });
});
