import { ompBridgeGuide } from "@ucch/providers";
import { describe, expect, it } from "vitest";
import { BRIDGE_TOOLS } from "./tools/index.js";

/**
 * The guide the CLIs are handed (solution §10.4) lives in `@ucch/providers`,
 * which cannot see the bridge; this keeps the two in step.
 */
describe("the bridge's usage guide", () => {
  it("names every tool the bridge offers, and nothing it does not", () => {
    const guide = ompBridgeGuide();
    for (const tool of BRIDGE_TOOLS) expect(guide, tool.name).toContain(`\`${tool.name}\``);
    const named = new Set(guide.match(/\bomp_[a-z_]+/g));
    expect([...named].sort()).toEqual(BRIDGE_TOOLS.map((tool) => tool.name).sort());
  });

  it("is about 25 lines, as §10.4 sizes it", () => {
    expect(ompBridgeGuide().split("\n").length).toBeLessThanOrEqual(25);
  });
});
