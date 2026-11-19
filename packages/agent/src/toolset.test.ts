import { describe, expect, it } from "vitest";
import { namedToolset } from "./registry.js";
import { turnTool } from "./run-tool.js";

describe("named toolsets", () => {
  it("offers exactly the named tools, in the registry's order, and caches the arrays", () => {
    const set = namedToolset(["read_file", "bash", "not_a_tool"]);
    expect(set.tools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);
    expect(set.schemas).toHaveLength(2);
    expect(namedToolset(["read_file", "bash", "not_a_tool"]).schemas).toBe(set.schemas);
  });

  it("looks tools up in the toolset instead of the preset", () => {
    const input = { preset: "standard" as const, registry: {}, toolset: ["bash"] };
    expect(turnTool(input, "bash")?.name).toBe("bash");
    expect(turnTool(input, "write_file")).toBeUndefined();
    expect(turnTool({ preset: "standard", registry: {} }, "write_file")?.name).toBe("write_file");
  });
});
