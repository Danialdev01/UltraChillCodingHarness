import { describe, expect, it } from "vitest";
import { checkKeyFormat, checkKeyLive, keyLast4, keyPrefix } from "./account-keys.js";
import { SlidingWindow } from "./step-up.js";

describe("prefix and last four", () => {
  it("keeps only the non-secret leading part", () => {
    expect(keyPrefix("openrouter", "sk-or-v1-abcdef")).toBe("sk-or-v1-");
    expect(keyPrefix("resend", "re_abc123")).toBe("re_");
    expect(keyPrefix("github", "ghp_abc")).toBe("ghp_");
    expect(keyPrefix("github", "github_pat_11ABC")).toBe("github_pat_");
    expect(keyPrefix("openrouter", "weird-legacy-key")).toBe("");
    expect(keyLast4("sk-or-v1-0000bf58")).toBe("bf58");
  });
});

describe("format", () => {
  it("accepts each provider's shape and refuses the others", () => {
    expect(checkKeyFormat("openrouter", `sk-or-v1-${"a".repeat(64)}`)).toBeNull();
    expect(checkKeyFormat("openrouter", "re_123456789")).toMatch(/sk-or-v1-/);
    expect(checkKeyFormat("resend", "re_123456789abc")).toBeNull();
    expect(checkKeyFormat("github", `ghp_${"A".repeat(36)}`)).toBeNull();
    expect(checkKeyFormat("github", `github_pat_${"A1_".repeat(25)}`)).toBeNull();
    expect(checkKeyFormat("github", "gho_notapat")).toMatch(/ghp_/);
    expect(checkKeyFormat("resend", "re_ 123")).toMatch(/spaces/);
  });
});

/** A fetch that answers once, and remembers what it was asked. */
function stub(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, calls };
}

describe("live check", () => {
  it("asks each provider the endpoint the brief names, with the key as a bearer", async () => {
    for (const [provider, url] of [
      ["openrouter", "https://openrouter.ai/api/v1/key"],
      ["resend", "https://api.resend.com/domains"],
      ["github", "https://api.github.com/user"],
    ] as const) {
      const { fetchImpl, calls } = stub(200, { "x-oauth-scopes": "repo" });
      expect((await checkKeyLive(provider, "the-key", fetchImpl)).ok).toBe(true);
      expect(calls[0]!.url).toBe(url);
      expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer the-key");
    }
  });

  it("reads GitHub scopes, and calls a token without the header fine-grained", async () => {
    expect(await checkKeyLive("github", "ghp_x", stub(200, { "x-oauth-scopes": "repo, read:org" }).fetchImpl)).toEqual({
      ok: true,
      scopes: "repo, read:org",
    });
    expect(await checkKeyLive("github", "github_pat_x", stub(200).fetchImpl)).toEqual({ ok: true, scopes: "fine-grained" });
  });

  it("explains a rejection without quoting the provider's body", async () => {
    const result = await checkKeyLive("openrouter", "sk-or-v1-secret", stub(401, {}, { error: "bad key sk-or-v1-secret" }).fetchImpl);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("OpenRouter rejected this key (HTTP 401)") });
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-secret");
  });

  it("accepts a sending-only Resend key", async () => {
    const result = await checkKeyLive("resend", "re_x", stub(401, {}, { name: "restricted_api_key" }).fetchImpl);
    expect(result).toEqual({ ok: true, scopes: null });
  });

  it("does not save when the provider cannot be reached", async () => {
    const result = await checkKeyLive("github", "ghp_x", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Couldn't reach GitHub") });
  });
});

describe("SlidingWindow", () => {
  it("allows max hits per window, then says how long to wait", () => {
    let now = 0;
    const window = new SlidingWindow(2, 1_000, () => now);
    window.hit("a");
    window.hit("a");
    expect(window.retryAfter("a")).toBe(1);
    expect(window.retryAfter("b")).toBe(0);
    now = 1_001;
    expect(window.retryAfter("a")).toBe(0);
  });
});
