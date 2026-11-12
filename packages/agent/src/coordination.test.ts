import { describe, expect, it } from "vitest";
import { hostToolSchemas, schemasFor } from "./registry.js";

describe("coordination registry gates", () => {
  const coordination = async () => ({ content: "ok" });
  it("keeps cached tool lists distinct between standalone, parent and child turns", () => {
    const names = (options = {}) => schemasFor("standard", options).map((t) => t.function.name);
    expect(names()).not.toContain("ucch_sessions");
    expect(names({ coordination, subagents: true })).toContain("ucch_agent");
    expect(names({ coordination })).toContain("ucch_message");
    expect(names({ coordination })).not.toContain("ucch_agent");
    expect(names()).not.toContain("ucch_message");
  });
  it("offers OMP host messaging and withholds recursive spawning", () => {
    const names = hostToolSchemas("standard", { coordination }).map((t) => t.name);
    expect(names).toContain("ucch_message");
    expect(names).not.toContain("ucch_agent");
  });
});
