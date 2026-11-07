import { describe, expect, it } from "vitest";
import { backfilledTitles } from "./session-titles.js";

const row = (over: Partial<Parameters<typeof backfilledTitles>[0][number]> = {}) => ({
  threadId: "t1",
  projectId: "p1",
  sessionCard: false,
  projectName: "BakeryShop",
  firstText: "identify project purpose",
  ...over,
});

describe("backfilledTitles", () => {
  it("titles a session from its first message the way the engine does", () => {
    expect(backfilledTitles([row()])).toEqual({ threads: [{ id: "t1", title: "Identify project purpose" }], projects: [] });
  });

  it("names a session workspace's card only while it still has the placeholder", () => {
    const out = backfilledTitles([
      row({ sessionCard: true, projectName: "New session" }),
      row({ threadId: "t2", projectId: "p2", sessionCard: true, projectName: "Already named" }),
    ]);
    expect(out.projects).toEqual([{ id: "p1", name: "Identify project purpose" }]);
    expect(out.threads).toHaveLength(2);
  });

  it("skips a message with nothing to title it by", () => {
    expect(backfilledTitles([row({ firstText: "```\ncode\n```" })])).toEqual({ threads: [], projects: [] });
  });
});
