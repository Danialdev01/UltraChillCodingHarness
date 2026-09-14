import { describe, expect, it } from "vitest";

import { breakdown, modelLabel, type ModelUsage } from "./usage-breakdown.js";

const usage = (model: string | null, costUsd: number, requests: number): ModelUsage => ({
  model,
  costUsd,
  requests,
  tokens: 0,
});

describe("ranking a card's rows", () => {
  it("names the largest three and sums the rest", () => {
    const rows = breakdown(
      [
        usage("a", 1, 0),
        usage("b", 2, 0),
        usage("c", 3, 0),
        usage("d", 4, 0),
        usage("e", 5, 0),
      ],
      (u) => u.costUsd,
    );

    expect(rows.map((row) => row.model)).toEqual(["e", "d", "c", null]);
    expect(rows.at(-1)).toEqual({ model: null, value: 3, others: true });
  });

  it("leaves out Others when nothing is left over", () => {
    const rows = breakdown([usage("a", 1, 0), usage("b", 2, 0)], (u) => u.costUsd);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.others)).toBe(false);
  });

  it("ranks each metric on its own", () => {
    // The cheap model that answers constantly: last by spend, first by count.
    const models = [usage("pricey", 5, 1), usage("cheap", 0, 90), usage("mid", 1, 4)];
    expect(breakdown(models, (u) => u.costUsd, 1)[0]?.model).toBe("pricey");
    expect(breakdown(models, (u) => u.requests, 1)[0]?.model).toBe("cheap");
  });

  it("keeps a model that cost nothing measurable", () => {
    const rows = breakdown([usage("a", 1, 0), usage("free", 0, 30)], (u) => u.costUsd);
    expect(rows.map((row) => row.model)).toEqual(["a", "free"]);
  });

  it("does not reorder the caller's array", () => {
    const models = [usage("a", 1, 0), usage("b", 9, 0)];
    breakdown(models, (u) => u.costUsd);
    expect(models[0]?.model).toBe("a");
  });
});

describe("naming a model", () => {
  const names = new Map([["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"]]);

  it("prefers the catalogue's own name", () => {
    expect(modelLabel("anthropic/claude-sonnet-4.5", names)).toBe("Claude Sonnet 4.5");
  });

  it("falls back to the last segment of an id it does not know", () => {
    expect(modelLabel("minimax/minimax-m2.5", names)).toBe("minimax-m2.5");
  });

  it("says what a missing model and a summed remainder are", () => {
    expect(modelLabel(null, names)).toBe("Unknown");
    expect(modelLabel(null, names, true)).toBe("Others");
  });
});
