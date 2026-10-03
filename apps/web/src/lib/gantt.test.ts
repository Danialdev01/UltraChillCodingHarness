import { describe, expect, it } from "vitest";

import {
  barGeometry,
  computeRange,
  dependencyPath,
  durationDays,
  fromDay,
  headerTicks,
  isWeekend,
  resizeTask,
  shiftTask,
  toDay,
  todayX,
  weekendBands,
} from "./gantt";

describe("toDay / fromDay", () => {
  it("round-trips a date and counts from the epoch", () => {
    expect(toDay("1970-01-01")).toBe(0);
    expect(toDay("1970-01-02")).toBe(1);
    expect(fromDay(toDay("2026-09-22"))).toBe("2026-09-22");
  });

  it("is a plain difference across a DST change", () => {
    expect(toDay("2026-03-30") - toDay("2026-03-28")).toBe(2);
  });
});

describe("durationDays and barGeometry", () => {
  it("counts the end day: a one-day task is one column wide", () => {
    expect(durationDays({ startsOn: "2026-09-01", endsOn: "2026-09-01" })).toBe(1);
    expect(durationDays({ startsOn: "2026-09-01", endsOn: "2026-09-05" })).toBe(5);
  });

  it("places the bar by its offset from the range start", () => {
    const range = { start: toDay("2026-09-01"), end: toDay("2026-09-30") };
    const bar = barGeometry({ startsOn: "2026-09-03", endsOn: "2026-09-04" }, range, 10);
    expect(bar).toEqual({ x: 20, width: 20 });
  });
});

describe("computeRange", () => {
  it("spans the tasks, today, and the padding", () => {
    const range = computeRange(
      [
        { startsOn: "2026-09-10", endsOn: "2026-09-12" },
        { startsOn: "2026-09-01", endsOn: "2026-09-03" },
      ],
      "2026-09-20",
      2,
    );
    expect(fromDay(range.start)).toBe("2026-08-30");
    expect(fromDay(range.end)).toBe("2026-09-22");
  });

  it("centres on today when there is nothing to show", () => {
    const range = computeRange([], "2026-09-20", 0);
    expect(fromDay(range.start)).toBe("2026-09-06");
    expect(fromDay(range.end)).toBe("2026-10-04");
  });
});

describe("todayX", () => {
  const range = { start: toDay("2026-09-01"), end: toDay("2026-09-10") };

  it("is the middle of today's column", () => {
    expect(todayX("2026-09-02", range, 10)).toBe(15);
  });

  it("is null when today is off the chart", () => {
    expect(todayX("2026-09-11", range, 10)).toBeNull();
    expect(todayX("2026-08-31", range, 10)).toBeNull();
  });
});

describe("headerTicks", () => {
  it("draws one month tick per month, across a year boundary, clipped to the range", () => {
    const range = { start: toDay("2026-12-30"), end: toDay("2027-01-02") };
    const { major } = headerTicks(range, "month", 10);
    expect(major).toEqual([
      { x: 0, width: 20, label: "Dec 2026" },
      { x: 20, width: 20, label: "Jan 2027" },
    ]);
  });

  it("draws a day tick per column at day zoom", () => {
    const range = { start: toDay("2026-09-01"), end: toDay("2026-09-03") };
    const { minor } = headerTicks(range, "day", 10);
    expect(minor.map((t) => t.label)).toEqual(["1", "2", "3"]);
  });

  it("draws Monday-to-Sunday weeks at week zoom, partial at the edges", () => {
    // 2026-09-02 is a Wednesday; the following Monday is the 7th.
    const range = { start: toDay("2026-09-02"), end: toDay("2026-09-15") };
    const { minor } = headerTicks(range, "week", 10);
    expect(minor).toEqual([
      { x: 0, width: 50, label: "2 Sep" },
      { x: 50, width: 70, label: "7 Sep" },
      { x: 120, width: 20, label: "14 Sep" },
    ]);
  });

  it("has no minor row at month zoom", () => {
    const range = { start: toDay("2026-09-01"), end: toDay("2026-09-30") };
    expect(headerTicks(range, "month", 5).minor).toEqual([]);
  });
});

describe("weekends", () => {
  it("knows which days are Saturday and Sunday", () => {
    expect(isWeekend(toDay("2026-09-19"))).toBe(true); // Saturday
    expect(isWeekend(toDay("2026-09-20"))).toBe(true); // Sunday
    expect(isWeekend(toDay("2026-09-21"))).toBe(false); // Monday
  });

  it("merges each Saturday and Sunday into one band", () => {
    const range = { start: toDay("2026-09-18"), end: toDay("2026-09-21") }; // Fri..Mon
    expect(weekendBands(range, 10)).toEqual([{ x: 10, width: 20 }]);
  });
});

describe("dependencyPath", () => {
  it("elbows across the gap when the second bar starts after the first ends", () => {
    const path = dependencyPath({ x: 0, width: 40, row: 0 }, { x: 80, row: 1 }, 20);
    expect(path).toBe("M 40 10 L 60 10 L 60 30 L 80 30");
  });

  it("loops out and back when the bars overlap", () => {
    const path = dependencyPath({ x: 0, width: 40, row: 0 }, { x: 30, row: 1 }, 20);
    expect(path.startsWith("M 40 10 L 48 10 L 48 20")).toBe(true);
    expect(path.endsWith("L 22 30 L 30 30")).toBe(true);
  });
});

describe("shiftTask and resizeTask", () => {
  const task = { startsOn: "2026-09-10", endsOn: "2026-09-12" };

  it("moves both ends together", () => {
    expect(shiftTask(task, 3)).toEqual({ startsOn: "2026-09-13", endsOn: "2026-09-15" });
    expect(shiftTask(task, -10)).toEqual({ startsOn: "2026-08-31", endsOn: "2026-09-02" });
  });

  it("moves one end and never past the other", () => {
    expect(resizeTask(task, "end", 2)).toEqual({ startsOn: "2026-09-10", endsOn: "2026-09-14" });
    expect(resizeTask(task, "end", -5)).toEqual({ startsOn: "2026-09-10", endsOn: "2026-09-10" });
    expect(resizeTask(task, "start", 1)).toEqual({ startsOn: "2026-09-11", endsOn: "2026-09-12" });
    expect(resizeTask(task, "start", 9)).toEqual({ startsOn: "2026-09-12", endsOn: "2026-09-12" });
  });
});
