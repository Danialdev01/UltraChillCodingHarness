import { describe, expect, it } from "vitest";
import { toRecord, wouldCycle } from "./timeline.js";

const rows = [
  { id: "a", dependsOnId: null },
  { id: "b", dependsOnId: "a" },
  { id: "c", dependsOnId: "b" },
  { id: "d", dependsOnId: null },
];

describe("wouldCycle", () => {
  it("allows an arrow from an unrelated task", () => {
    expect(wouldCycle(rows, "d", "c")).toBe(false);
    expect(wouldCycle(rows, "a", "d")).toBe(false);
  });

  it("refuses an arrow that comes back around, at any distance", () => {
    expect(wouldCycle(rows, "a", "b")).toBe(true);
    expect(wouldCycle(rows, "a", "c")).toBe(true);
  });

  it("refuses a task depending on itself", () => {
    expect(wouldCycle(rows, "a", "a")).toBe(true);
  });

  it("terminates on a loop already in the data", () => {
    const cyclic = [
      { id: "x", dependsOnId: "y" },
      { id: "y", dependsOnId: "x" },
    ];
    expect(wouldCycle(cyclic, "z", "x")).toBe(false);
  });
});

describe("toRecord", () => {
  it("keeps dates as calendar days and turns instants into ISO strings", () => {
    const record = toRecord({
      id: "t",
      projectId: "p",
      title: "Design",
      startsOn: "2026-09-01",
      endsOn: "2026-09-05",
      progress: 40,
      colour: "green",
      position: 2,
      dependsOnId: null,
      createdAt: new Date("2026-09-01T10:00:00Z"),
      updatedAt: new Date("2026-09-02T10:00:00Z"),
    });
    expect(record.startsOn).toBe("2026-09-01");
    expect(record.endsOn).toBe("2026-09-05");
    expect(record.updatedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(record).not.toHaveProperty("projectId");
  });
});
