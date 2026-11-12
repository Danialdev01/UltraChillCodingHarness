import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaService } from "./quotas.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("subscription quota cache", () => {
  const providers = { credsDir: (subject: string) => `/tmp/no-ucch-credentials-${subject}`, claudeToken: async () => "test-token" };
  it("coalesces lookups, caches for a minute, and separates billing subjects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 42 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const service = new SubscriptionQuotaService(providers);
    const [first, second] = await Promise.all([service.get("member", "claude"), service.get("member", "claude")]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ status: "ok", windows: [{ usedPercent: 42 }] });
    await service.get("member", "claude");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await service.get("ws-dedicated", "claude");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    await service.get("member", "claude");
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });
  it("returns unknown availability when the endpoint fails, allowing a CLI attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await new SubscriptionQuotaService(providers).get("member", "claude")).toEqual({ provider: "claude", status: "unavailable" });
  });
});
