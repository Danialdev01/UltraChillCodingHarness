import { describe, expect, it } from "vitest";
import {
  describeQuota,
  compactNumber,
  describeContainerState,
  formatUsd,
  relativeTime,
  shortRepo,
} from "./stats-format.js";

describe("large counts", () => {
  it("writes small numbers as they are", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(999)).toBe("999");
  });

  it("shortens the way a person would say it", () => {
    expect(compactNumber(1000)).toBe("1k");
    expect(compactNumber(12_400)).toBe("12.4k");
    expect(compactNumber(3_100_000)).toBe("3.1M");
    expect(compactNumber(2_000_000_000)).toBe("2B");
  });

  it("drops the decimal once it stops adding anything", () => {
    // 340.0M is not clearer than 340M, but 1.2M is clearer than 1M.
    expect(compactNumber(340_000_000)).toBe("340M");
    expect(compactNumber(1_200_000)).toBe("1.2M");
  });

  it("does not report a negative or fractional count", () => {
    expect(compactNumber(-5)).toBe("0");
    expect(compactNumber(1499.6)).toBe("1.5k");
  });
});

describe("money", () => {
  it("keeps enough digits that a sub-cent total is not shown as free", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0004)).toBe("$0.0004");
    expect(formatUsd(0.42)).toBe("$0.42");
  });

  it("drops the cents once they stop mattering", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(4210.7)).toBe("$4,211");
  });
});

describe("how long ago", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);

  it("uses the coarsest unit that is still true", () => {
    expect(ago(90 * 1000)).toBe("1m ago");
    expect(ago(3 * 3600 * 1000)).toBe("3h ago");
    expect(ago(2 * 86400 * 1000)).toBe("2d ago");
    expect(ago(70 * 86400 * 1000)).toBe("2mo ago");
    expect(ago(400 * 86400 * 1000)).toBe("1y ago");
  });

  it("says just now inside the first minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * 1000)).toBe("just now");
  });

  it("does not report the future when a clock runs ahead", () => {
    // A browser a few seconds ahead of the server is ordinary; "in 4s" as a
    // last-active time is not.
    expect(relativeTime(new Date(now + 4000).toISOString(), now)).toBe("just now");
  });

  it("returns a dash for a missing or unparseable timestamp", () => {
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime("not a date", now)).toBe("—");
  });
});

describe("container state", () => {
  it("gives running its own tone, and failures theirs", () => {
    expect(describeContainerState("running")).toEqual({ label: "Running", tone: "live" });
    expect(describeContainerState("error").tone).toBe("failed");
    expect(describeContainerState("building").tone).toBe("busy");
  });

  it("reads absent as what it means to a person", () => {
    expect(describeContainerState("absent").label).toBe("Not built");
  });

  it("passes a state it does not know through rather than hiding it", () => {
    expect(describeContainerState("quarantined")).toEqual({
      label: "quarantined",
      tone: "idle",
    });
    expect(describeContainerState("").label).toBe("Unknown");
  });
});

describe("repository names", () => {
  it("keeps the part anyone reads", () => {
    expect(shortRepo("https://github.com/laravel/laravel.git")).toBe("laravel/laravel");
    expect(shortRepo("git@github.com:vercel/next.js.git")).toBe("vercel/next.js");
    expect(shortRepo("https://gitlab.com/group/sub/repo/")).toBe("sub/repo");
  });

  it("has something to show for an unusual or missing url", () => {
    expect(shortRepo(undefined)).toBe("—");
    expect(shortRepo("local")).toBe("local");
  });
});

describe("the quota card", () => {
  const quota = (over: Partial<Parameters<typeof describeQuota>[0]> = {}) => ({
    label: "harness",
    usageUsd: 12.5,
    limitUsd: 50,
    limitRemainingUsd: 37.5,
    freeTier: false,
    credits: { totalUsd: 100, usedUsd: 40 },
    ...over,
  });

  it("headlines the tighter of the key limit and the balance, and names it", () => {
    const keyBound = describeQuota(quota());
    expect(keyBound.value).toBe("$37.50");
    expect(keyBound.detail).toBe("left of the $50.00 key limit");
    expect(keyBound.footnote).toBe("$60.00 account balance");

    const balanceBound = describeQuota(quota({ credits: { totalUsd: 20, usedUsd: 15 } }));
    expect(balanceBound.value).toBe("$5.00");
    expect(balanceBound.detail).toBe("credit balance · $15.00 used");
    expect(balanceBound.footnote).toBe("$37.50 left on the key limit");
  });

  it("uses whichever ceiling it has when only one is known", () => {
    const keyOnly = describeQuota(quota({ credits: null }));
    expect(keyOnly.value).toBe("$37.50");
    expect(keyOnly.footnote).toBe("$12.50 spent through key “harness”");

    const balanceOnly = describeQuota(quota({ limitUsd: null, limitRemainingUsd: null }));
    expect(balanceOnly.value).toBe("$60.00");
    expect(balanceOnly.detail).toBe("credit balance · $40.00 used");
    expect(balanceOnly.footnote).toBe("Key “harness” has no spending limit of its own");
  });

  it("shows spend, labelled as spend, when there is no ceiling to show", () => {
    const card = describeQuota(
      quota({ limitUsd: null, limitRemainingUsd: null, credits: null, label: null, freeTier: true }),
    );
    expect(card.value).toBe("$12.50");
    expect(card.detail).toBe("spent through this key · no limit set");
    expect(card.footnote).toBe("This key · free tier · balance not readable");
  });

  it("never shows a negative balance", () => {
    const card = describeQuota(quota({ limitRemainingUsd: -3, credits: { totalUsd: 5, usedUsd: 9 } }));
    expect(card.value).toBe("$0.00");
    expect(card.footnote).toBe("$0.00 left on the key limit");
  });

  it("puts the exact figures in the title", () => {
    expect(describeQuota(quota()).title).toBe(
      "$12.50 spent through this key · key limit $50.00 · account credits $100.00, used $40.00",
    );
  });
});
