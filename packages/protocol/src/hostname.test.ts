import { describe, expect, it } from "vitest";
import { parseHost, parsePathAlias, previewUrl, projectUrl } from "./hostname.js";

const ROOT = "ucch.danialirfan.dev";
const HASH = "a1b2c3d4e5f6";

describe("parseHost", () => {
  it("routes the bare root and www to the web app", () => {
    expect(parseHost(ROOT, ROOT)).toEqual({ kind: "web" });
    expect(parseHost(`www.${ROOT}`, ROOT)).toEqual({ kind: "web" });
  });

  it("routes api to the server", () => {
    expect(parseHost(`api.${ROOT}`, ROOT)).toEqual({ kind: "api" });
  });

  it("routes a project port subdomain", () => {
    expect(parseHost(`p3000-${HASH}.${ROOT}`, ROOT)).toEqual({
      kind: "project",
      projectHash: HASH,
      port: 3000,
    });
  });

  it("routes a preview subdomain", () => {
    expect(parseHost(`pv-${HASH}.${ROOT}`, ROOT)).toEqual({
      kind: "preview",
      previewHash: HASH,
    });
  });

  it("ignores a port suffix and trailing dot, and is case-insensitive", () => {
    const expected = { kind: "project", projectHash: HASH, port: 8000 };
    expect(parseHost(`p8000-${HASH}.${ROOT}:443`, ROOT)).toEqual(expected);
    expect(parseHost(`P8000-${HASH.toUpperCase()}.${ROOT}.`, ROOT)).toEqual(expected);
  });

  // A nested label must not resolve: otherwise any host that merely *ends*
  // with a valid project label would be proxied into that container.
  it("rejects nested subdomains", () => {
    expect(parseHost(`evil.p3000-${HASH}.${ROOT}`, ROOT).kind).toBe("unknown");
  });

  it("rejects hosts outside the root domain", () => {
    expect(parseHost(`p3000-${HASH}.attacker.com`, ROOT).kind).toBe("unknown");
    // Suffix-similar domain: endsWith() alone would accept this without the
    // leading-dot check.
    expect(parseHost(`p3000-${HASH}.evilucch.danialirfan.dev`, ROOT).kind).toBe("unknown");
  });

  it("rejects privileged and out-of-range ports", () => {
    expect(parseHost(`p80-${HASH}.${ROOT}`, ROOT).kind).toBe("unknown");
    expect(parseHost(`p99999-${HASH}.${ROOT}`, ROOT).kind).toBe("unknown");
  });

  it("rejects malformed hashes", () => {
    expect(parseHost(`p3000-tooshort.${ROOT}`, ROOT).kind).toBe("unknown");
    // 12 chars but outside the alphabet -- the underscore is not DNS-safe.
    expect(parseHost(`p3000-abc_def12345.${ROOT}`, ROOT).kind).toBe("unknown");
    // 13 chars: length must be exact, not a minimum.
    expect(parseHost(`p3000-a1b2c3d4e5f6g.${ROOT}`, ROOT).kind).toBe("unknown");
    expect(parseHost(`pv-.${ROOT}`, ROOT).kind).toBe("unknown");
  });

  it("rejects empty and unrecognized prefixes", () => {
    expect(parseHost(`.${ROOT}`, ROOT).kind).toBe("unknown");
    expect(parseHost(`admin.${ROOT}`, ROOT).kind).toBe("unknown");
  });

  it("works against a local wildcard root", () => {
    expect(parseHost(`p5173-${HASH}.ucch.localhost`, "ucch.localhost")).toEqual({
      kind: "project",
      projectHash: HASH,
      port: 5173,
    });
  });
});

describe("url builders", () => {
  it("round-trips through parseHost", () => {
    const url = new URL(projectUrl(HASH, 3000, ROOT));
    expect(parseHost(url.host, ROOT)).toEqual({ kind: "project", projectHash: HASH, port: 3000 });

    const preview = new URL(previewUrl(HASH, ROOT));
    expect(parseHost(preview.host, ROOT)).toEqual({ kind: "preview", previewHash: HASH });
  });

  it("refuses to build a URL from invalid input", () => {
    expect(() => projectUrl("bad", 3000, ROOT)).toThrow();
    expect(() => projectUrl(HASH, 80, ROOT)).toThrow();
  });
});

describe("parsePathAlias", () => {
  it("parses the legacy path form", () => {
    expect(parsePathAlias(`/${HASH}/port:3000/login`)).toEqual({
      projectHash: HASH,
      port: 3000,
      rest: "/login",
    });
  });

  it("defaults a missing tail to root", () => {
    expect(parsePathAlias(`/${HASH}/port:3000`)?.rest).toBe("/");
  });

  it("returns null for non-alias paths", () => {
    expect(parsePathAlias("/dashboard")).toBeNull();
    expect(parsePathAlias(`/${HASH}/port:80/x`)).toBeNull();
  });
});
