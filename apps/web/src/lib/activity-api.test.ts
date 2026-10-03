import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@ucch/protocol";

import { matchesAction, upsertEntry } from "./activity-api";

const entry = (id: string, action = "note.update", count = 1): AuditEntry => ({
  id,
  projectId: null,
  userId: null,
  actor: "dev",
  clientId: null,
  action,
  targetType: "note",
  targetId: null,
  summary: `entry ${id}`,
  details: {},
  count,
  createdAt: "2026-10-03T12:00:00.000Z",
  updatedAt: "2026-10-03T12:00:00.000Z",
});

describe("upsertEntry", () => {
  it("puts a new entry first", () => {
    expect(upsertEntry([entry("1")], entry("2")).map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("replaces a coalesced entry and moves it to the top", () => {
    const next = upsertEntry([entry("2"), entry("1")], entry("1", "note.update", 3));
    expect(next.map((e) => [e.id, e.count])).toEqual([
      ["1", 3],
      ["2", 1],
    ]);
  });
});

describe("matchesAction", () => {
  it("matches by prefix, and everything without a filter", () => {
    expect(matchesAction(entry("1", "note.conflict"), "note")).toBe(true);
    expect(matchesAction(entry("1", "file.write"), "note")).toBe(false);
    expect(matchesAction(entry("1", "file.write"), undefined)).toBe(true);
  });
});
