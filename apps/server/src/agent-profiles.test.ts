import { describe, expect, it } from "vitest";
import { cleanLabel, contextAllowed, ESTIMATED_LIMIT_MS, isDefaultRow, limitedUntil, toView } from "./agent-profiles.js";
import { isDefaultProfile, profileKey } from "./profile-ref.js";

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: "p1",
    subject: "u1",
    provider: "claude",
    label: "Work",
    context: "work",
    dirName: "claude-abc",
    authStatus: "signed_in",
    limitResetsAt: null,
    limitEstimated: false,
    lastUsedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...over,
  }) as never;

describe("profiles", () => {
  it("know the Default account by its folder, which is the provider's own", () => {
    expect(isDefaultRow({ provider: "claude", dirName: "claude" })).toBe(true);
    expect(isDefaultRow({ provider: "claude", dirName: "claude-abc" })).toBe(false);
    expect(isDefaultProfile("codex", undefined)).toBe(true);
    expect(profileKey("u1", "claude", { id: "p1", dirName: "claude" })).toBe("u1");
    expect(profileKey("u1", "claude", { id: "p1", dirName: "claude-abc" })).toBe("u1/p1");
  });

  it("clean a label, and refuse an empty or overlong one", () => {
    expect(cleanLabel("  My   work  ")).toBe("My work");
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel("x".repeat(41))).toBeNull();
    expect(cleanLabel(3)).toBeNull();
  });

  it("are limited only while the reset time is ahead", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(limitedUntil(row({ limitResetsAt: new Date(now + 60_000) }), now)).not.toBeNull();
    expect(limitedUntil(row({ limitResetsAt: new Date(now - 60_000) }), now)).toBeNull();
    const view = toView(row({ limitResetsAt: new Date(now - 1), limitEstimated: true }), now);
    expect(view).toMatchObject({ limitedUntil: null, limitEstimated: false, isDefault: false, context: "work" });
    expect(ESTIMATED_LIMIT_MS).toBe(5 * 60 * 60_000);
  });

  it("match a project's required context, and anything when it asks for none", () => {
    expect(contextAllowed(null, "personal")).toBe(true);
    expect(contextAllowed("work", "work")).toBe(true);
    expect(contextAllowed("work", "personal")).toBe(false);
  });
});
