import { describe, expect, it } from "vitest";
import { accountBlocker, limitOptions, limitReset, type HarnessAvailability } from "./choices.js";

const harnesses: HarnessAvailability[] = [
  { provider: "claude", label: "Claude Code", usable: true, blocker: null, custom: false },
  { provider: "codex", label: "Codex", usable: true, blocker: null, custom: false },
  { provider: "native", label: "Custom (OpenRouter)", usable: false, blocker: "Add an OpenRouter key in Settings", custom: true },
];

describe("limitOptions", () => {
  it("offers every other harness, then the limited provider's other accounts, each as a person's choice", () => {
    const options = limitOptions(harnesses, "claude", [
      { id: "11111111-1111-1111-1111-111111111111", label: "Personal" },
      { id: "22222222-2222-2222-2222-222222222222", label: "Spare", blocker: "Limited until 14:00 UTC" },
    ]);
    expect(options.map((o) => o.id)).toEqual([
      "codex",
      "custom",
      "profile:11111111-1111-1111-1111-111111111111",
      "profile:22222222-2222-2222-2222-222222222222",
    ]);
    expect(options[2]).toMatchObject({
      label: "Continue on another Claude Code account: Personal",
      provider: "claude",
      profileId: "11111111-1111-1111-1111-111111111111",
      detail: "Plan limits assume individual use",
    });
    expect(options[2]).not.toHaveProperty("blocker");
    expect(options[3]).toMatchObject({ blocker: "Limited until 14:00 UTC" });
  });

  it("offers no accounts when there are none", () => {
    expect(limitOptions(harnesses, "codex").every((o) => !o.profileId)).toBe(true);
  });
});

describe("limitReset", () => {
  const now = Date.parse("2026-11-24T10:00:00Z");
  it("is the latest reset of the windows that are spent", () => {
    const session = { usedPercent: 100, resetsAt: "2026-11-24T12:00:00.000Z" };
    const weekly = { usedPercent: 60, resetsAt: "2026-11-28T12:00:00.000Z" };
    expect(limitReset([session, weekly], now)).toBe(session.resetsAt);
    expect(limitReset([session, { ...weekly, usedPercent: 100 }], now)).toBe(weekly.resetsAt);
    expect(limitReset([weekly], now)).toBeNull();
  });
});

describe("accountBlocker", () => {
  const account = { authStatus: "signed_in", limitedUntil: null, context: "work" };
  it("blocks the wrong context, a limited account and a signed-out one", () => {
    expect(accountBlocker(account, null)).toBeNull();
    expect(accountBlocker(account, "personal")).toMatch(/needs a personal account/);
    expect(accountBlocker({ ...account, limitedUntil: "2026-11-14T14:05:00.000Z" }, null)).toBe("Limited until 14:05 UTC");
    expect(accountBlocker({ ...account, authStatus: "signed_out" }, null)).toMatch(/Sign in/);
  });
});
