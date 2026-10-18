import { describe, expect, it } from "vitest";
import { DEFAULT_TREE_FONT_SIZE, treeMetrics, treeMetricsStyle } from "./tree-font-size.js";

describe("tree metrics", () => {
  it("are the explorer's compact row at the default size", () => {
    expect(DEFAULT_TREE_FONT_SIZE).toBe(13);
    expect(treeMetrics(13)).toEqual({
      rowHeight: 22,
      iconSize: 16,
      chevronBox: 16,
      chevronGlyph: 12,
      gapChevron: 2,
      gapLabel: 6,
      padX: 8,
      indent: 8,
    });
  });

  it("scale in proportion with the font", () => {
    const m = treeMetrics(26);
    expect(m.rowHeight).toBe(44);
    expect(m.iconSize).toBe(32);
    expect(m.indent).toBe(16);
  });

  it("never make a row shorter than its text", () => {
    for (let size = 10; size <= 24; size++) expect(treeMetrics(size).rowHeight).toBeGreaterThanOrEqual(size * 1.25);
  });

  it("are written as the variables the tree reads", () => {
    const style = treeMetricsStyle(13);
    expect(style["--tree-row-height"]).toBe("22px");
    expect(style["--tree-font-size"]).toBe("13px");
  });
});
