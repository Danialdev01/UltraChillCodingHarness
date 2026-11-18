import { describe, expect, it } from "vitest";
import { planDraftPrompt, planRunPrompt, proposedPlanIn, stripPlanTags } from "./plan-mode.js";

describe("plan mode", () => {
  it("finds the newest finished plan, and none while one is still being written", () => {
    expect(proposedPlanIn("Questions first:\n1. Which theme?")).toBeNull();
    expect(proposedPlanIn("Here:\n<proposed_plan>\n1. Do A\n</proposed_plan>\nDone.")).toBe("1. Do A");
    expect(proposedPlanIn("<proposed_plan>old</proposed_plan> then <proposed_plan>new</proposed_plan>")).toBe("new");
    expect(proposedPlanIn("<proposed_plan>half written")).toBeNull();
    expect(proposedPlanIn("<proposed_plan>  </proposed_plan>")).toBeNull();
  });

  it("drops the tags from what is shown and keeps the plan", () => {
    expect(stripPlanTags("A\n<proposed_plan>\n# Plan\n</proposed_plan>")).toBe("A\n\n# Plan\n");
  });

  it("tells a draft to plan and ask, and a run to carry the plan out", () => {
    expect(planDraftPrompt("add dark mode")).toMatch(/plan mode[\s\S]*add dark mode$/);
    const run = planRunPrompt("1. Do A", "Run the plan.");
    expect(run).toContain("<approved-plan>\n1. Do A\n</approved-plan>");
    expect(run).toMatch(/every step/);
    expect(run.endsWith("Run the plan.")).toBe(true);
  });
});
