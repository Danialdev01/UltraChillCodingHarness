import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_AUTO_RUN, type ProjectTask, type TaskAutoRun } from "@ucch/protocol";
import { TaskScheduler, isDue, localClock, usageBlock } from "./task-scheduler.js";
import type { SessionQuota } from "./quotas.js";

const weekdays: TaskAutoRun = { ...DEFAULT_TASK_AUTO_RUN, enabled: true, time: "02:00", timezone: "UTC" };
// Wednesday 2026-10-07.
const at = (iso: string) => new Date(iso);

describe("localClock", () => {
  it("reads the day and minute in the zone, not the server's", () => {
    const clock = localClock(at("2026-10-07T23:30:00Z"), "Asia/Tokyo");
    expect(clock).toEqual({ date: "2026-10-08", weekday: 4, minutes: 8 * 60 + 30 });
  });

  it("falls back to UTC for a zone it does not know", () => {
    expect(localClock(at("2026-10-07T01:00:00Z"), "Nowhere/Else").minutes).toBe(60);
  });
});

describe("isDue", () => {
  it("is due at the slot on an enabled day", () => {
    expect(isDue(at("2026-10-07T02:00:00Z"), weekdays)).toBe(true);
    expect(isDue(at("2026-10-07T02:20:00Z"), weekdays)).toBe(true);
  });

  it("is not due before the slot, long after it, or on another day", () => {
    expect(isDue(at("2026-10-07T01:59:00Z"), weekdays)).toBe(false);
    expect(isDue(at("2026-10-07T03:00:00Z"), weekdays)).toBe(false);
    // Sunday.
    expect(isDue(at("2026-10-04T02:00:00Z"), weekdays)).toBe(false);
  });

  it("runs once a day", () => {
    const ran = { ...weekdays, lastRunAt: "2026-10-07T02:00:30Z" };
    expect(isDue(at("2026-10-07T02:05:00Z"), ran)).toBe(false);
    expect(isDue(at("2026-10-08T02:00:00Z"), ran)).toBe(true);
  });

  it("is never due when off", () => {
    expect(isDue(at("2026-10-07T02:00:00Z"), { ...weekdays, enabled: false })).toBe(false);
  });
});

const ok = (...used: number[]): SessionQuota => ({
  provider: "claude",
  status: "ok",
  checkedAt: "2026-10-07T00:00:00Z",
  windows: used.map((usedPercent, i) => ({
    id: i === 0 ? "session" : "weekly",
    label: i === 0 ? "5-hour" : "Weekly",
    usedPercent,
    resetsAt: null,
  })),
});

describe("usageBlock", () => {
  it("allows a run under the limit in every window", () => {
    expect(usageBlock(ok(79.9, 40))).toBeNull();
  });

  it("blocks at 80% in any window", () => {
    expect(usageBlock(ok(10, 80))).toMatch(/Weekly usage at 80%/);
    expect(usageBlock(ok(95, 10))).toMatch(/5-hour usage at 95%/);
  });

  it("blocks when usage cannot be read", () => {
    expect(usageBlock({ provider: "codex", status: "no_auth" })).toMatch(/not signed in/);
    expect(usageBlock({ provider: "claude", status: "unavailable", error: "x" })).toMatch(/could not be read/);
  });
});

describe("TaskScheduler", () => {
  const idea = { id: "t1", stage: "idea" } as ProjectTask;

  function scheduler(quota: SessionQuota) {
    const deps = {
      tasks: {
        autoRunProjects: vi.fn(async () => [
          { projectId: "p1", userId: "u1", provider: "claude", autoRun: weekdays },
        ]),
        ideas: vi.fn(async () => [idea]),
        move: vi.fn(async () => ({ ...idea, stage: "research" }) as ProjectTask),
        recordAutoRun: vi.fn(async () => {}),
      },
      quotaFor: vi.fn(async () => quota),
      defaultProviderOf: vi.fn(async () => null),
      enqueue: vi.fn(),
      announce: vi.fn(async () => {}),
      onError: vi.fn(),
    };
    return { deps, scheduler: new TaskScheduler(deps) };
  }

  it("moves ideas to Research and queues them when the slot is due", async () => {
    const { deps, scheduler: s } = scheduler(ok(20, 20));
    await s.tick(at("2026-10-07T02:00:00Z"));
    expect(deps.tasks.move).toHaveBeenCalledWith("p1", "t1", "research");
    expect(deps.enqueue).toHaveBeenCalledWith("p1", "t1");
    expect(deps.tasks.recordAutoRun).toHaveBeenCalledWith("p1", expect.any(String), "ran: 1 moved to Research");
  });

  it("skips the run, and says why, at 80% usage", async () => {
    const { deps, scheduler: s } = scheduler(ok(85, 20));
    await s.tick(at("2026-10-07T02:00:00Z"));
    expect(deps.quotaFor).toHaveBeenCalledWith("u1", "claude");
    expect(deps.tasks.move).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.tasks.recordAutoRun).toHaveBeenCalledWith("p1", expect.any(String), expect.stringMatching(/85%/));
  });

  it("does nothing outside the slot", async () => {
    const { deps, scheduler: s } = scheduler(ok(0));
    await s.tick(at("2026-10-07T12:00:00Z"));
    expect(deps.quotaFor).not.toHaveBeenCalled();
  });
});
