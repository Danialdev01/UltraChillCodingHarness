import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaService, type QuotaSource } from "./quotas.js";

afterEach(() => { vi.restoreAllMocks(); });

const reading = { windows: [{ id: "session" as const, usedPercent: 42, resetsAt: null, minutes: 300 }], limited: false };

function source(overrides: Partial<QuotaSource> = {}): QuotaSource {
  return { rateLimits: vi.fn(async () => reading), signedIn: vi.fn(async () => true), ...overrides };
}

describe("subscription quotas", () => {
  it("asks Codex itself, coalesces lookups, caches for a minute, and separates billing subjects", async () => {
    const src = source();
    const service = new SubscriptionQuotaService(src);
    const [first, second] = await Promise.all([service.get("member", "codex"), service.get("member", "codex")]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ status: "ok", windows: [{ usedPercent: 42, label: "Session (5h)" }] });
    await service.get("member", "codex");
    expect(src.rateLimits).toHaveBeenCalledTimes(1);
    await service.get("ws-dedicated", "codex");
    expect(src.rateLimits).toHaveBeenCalledTimes(2);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    await service.get("member", "codex");
    expect(src.rateLimits).toHaveBeenCalledTimes(3);
  });

  it("reports Codex as unavailable when the CLI cannot say, and no_auth when signed out", async () => {
    const failing = new SubscriptionQuotaService(source({ rateLimits: async () => { throw new Error("timed out"); } }));
    expect(await failing.get("member", "codex")).toEqual({ provider: "codex", status: "unavailable", error: "timed out" });
    const out = new SubscriptionQuotaService(source({ signedIn: async () => false }));
    expect(await out.get("member", "codex")).toEqual({ provider: "codex", status: "no_auth" });
  });

  it("shows Claude's last turn's own reading, per subject, and never asks for one", async () => {
    const src = source();
    const service = new SubscriptionQuotaService(src);
    expect(await service.get("member", "claude")).toMatchObject({ status: "unavailable" });
    service.record("member", [{ id: "weekly", usedPercent: 38, resetsAt: "2026-09-15T22:00:00.000Z" }]);
    expect(await service.get("member", "claude")).toMatchObject({ status: "ok", windows: [{ id: "weekly", usedPercent: 38 }] });
    expect(await service.get("ws-dedicated", "claude")).toMatchObject({ status: "unavailable" });
    expect(src.rateLimits).not.toHaveBeenCalled();
    service.forget("member");
    expect(await service.get("member", "claude")).toMatchObject({ status: "unavailable" });
  });
});
