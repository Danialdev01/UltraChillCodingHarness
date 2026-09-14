import { describe, expect, it } from "vitest";
import {
  contextPercent,
  contextUsage,
  formatContextTokens,
  FULL_RATIO,
  WARN_RATIO,
} from "./context-window.js";

describe("token counts in the composer", () => {
  it("reads in the units the row has space for", () => {
    expect(formatContextTokens(840)).toBe("840");
    expect(formatContextTokens(12_400)).toBe("12.4k");
    // Not "12.0k": a decimal that says nothing is a false precision.
    expect(formatContextTokens(12_000)).toBe("12k");
    expect(formatContextTokens(200_000)).toBe("200k");
    expect(formatContextTokens(1_048_576)).toBe("1M");
    expect(formatContextTokens(1_500_000)).toBe("1.5M");
  });
});

describe("the meter", () => {
  it("fills in proportion and says what it is out of", () => {
    const usage = contextUsage(50_000, 200_000);
    expect(usage.ratio).toBeCloseTo(0.25, 6);
    expect(usage.label).toBe("50k / 200k");
    expect(usage.tone).toBe("normal");
  });

  it("changes colour before the wall, not at it", () => {
    // Clearing is cheap at three quarters and disruptive once a turn is
    // refused for length, so the warning has to come with room to spare.
    expect(contextUsage(WARN_RATIO * 1000 - 1, 1000).tone).toBe("normal");
    expect(contextUsage(WARN_RATIO * 1000, 1000).tone).toBe("warn");
    expect(contextUsage(FULL_RATIO * 1000, 1000).tone).toBe("full");
  });

  it("never overflows the bar, whatever the provider counts", () => {
    // A provider counting a little differently from the published window
    // should turn the bar red, not stretch it past its track.
    const over = contextUsage(300_000, 200_000);
    expect(over.ratio).toBe(1);
    expect(over.tone).toBe("full");
  });
});

describe("what it says when it does not know", () => {
  it("distinguishes no turns yet from a model with no published window", () => {
    // Two different unknowns: one resolves after the first reply, the other
    // never does, and showing a bar for either would be an invention.
    const fresh = contextUsage(null, 200_000);
    expect(fresh.tone).toBe("idle");
    expect(fresh.ratio).toBeNull();
    expect(fresh.label).toBe("0 / 200k");

    const unpublished = contextUsage(12_000, null);
    expect(unpublished.tone).toBe("normal");
    expect(unpublished.ratio).toBeNull();
    expect(unpublished.label).toBe("12k");
  });

  it("knows nothing at all before the first turn on an unlisted model", () => {
    expect(contextUsage(null, null).label).toBe("no turns yet");
  });

  it("treats a nonsense window as no window", () => {
    expect(contextUsage(1000, 0).ratio).toBeNull();
    expect(contextUsage(1000, -5).ratio).toBeNull();
  });
});

describe("the percentage", () => {
  it("rounds up, so a used window never reads as empty", () => {
    // 40 tokens of 200k is 0.02%, and "0%" next to a visible sliver of bar
    // reads as broken.
    expect(contextPercent(0.0002)).toBe(1);
    expect(contextPercent(0.251)).toBe(26);
    expect(contextPercent(1)).toBe(100);
  });
});
