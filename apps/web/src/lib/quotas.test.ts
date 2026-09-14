import { describe, expect, it } from "vitest";
import { formatResetsIn, primaryWindow, quotaTone, type SessionQuota } from "./quotas.js";

describe("which window the bar draws", () => {
  it("is the session window when there is one, else the first", () => {
    const ok: SessionQuota = {
      provider: "claude",
      status: "ok",
      checkedAt: "2026-09-14T10:00:00Z",
      windows: [
        { id: "weekly", label: "Weekly", usedPercent: 49, resetsAt: null },
        { id: "session", label: "Session (5h)", usedPercent: 47, resetsAt: null },
      ],
    };
    expect(primaryWindow(ok)?.id).toBe("session");
    expect(primaryWindow({ ...ok, windows: [ok.windows[0]!] })?.id).toBe("weekly");
    expect(primaryWindow({ ...ok, windows: [] })).toBeNull();
    expect(primaryWindow({ provider: "codex", status: "no_auth" })).toBeNull();
  });
});

describe("the bar's colour", () => {
  it("turns at the context meter's thresholds", () => {
    expect(quotaTone(null)).toBe("idle");
    expect(quotaTone(0)).toBe("normal");
    expect(quotaTone(74)).toBe("normal");
    expect(quotaTone(75)).toBe("warn");
    expect(quotaTone(90)).toBe("full");
  });
});

describe("when it resets", () => {
  const now = Date.parse("2026-09-14T10:00:00Z");

  it("is coarse, and empty when unknown", () => {
    expect(formatResetsIn(null, now)).toBe("");
    expect(formatResetsIn("not a date", now)).toBe("");
    expect(formatResetsIn("2026-09-14T09:00:00Z", now)).toBe("resets now");
    expect(formatResetsIn("2026-09-14T10:20:00Z", now)).toBe("resets in 20m");
    expect(formatResetsIn("2026-09-14T12:15:00Z", now)).toBe("resets in 2h 15m");
    expect(formatResetsIn("2026-09-14T13:00:00Z", now)).toBe("resets in 3h");
    expect(formatResetsIn("2026-09-16T13:00:00Z", now)).toBe("resets in 2d 3h");
    expect(formatResetsIn("2026-09-21T10:00:00Z", now)).toBe("resets in 7d");
  });
});
