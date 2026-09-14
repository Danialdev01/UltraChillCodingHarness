import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ALL, buildSchemas, schemasFor, selectPreset, toolsFor } from "./registry.js";
import { defineTool, type AnyTool } from "./tool.js";
import { toJsonSchema } from "./schema.js";

const tool = (name: string, permission: "read" | "write" | "exec", schema = z.strictObject({})) =>
  defineTool({
    name,
    description: `the ${name} tool`,
    inputSchema: schema,
    permission,
    async run() {
      return { content: name };
    },
  }) as AnyTool;

// Deliberately not in alphabetical order: the point of the array is that its
// order is arbitrary but fixed, and nothing downstream may re-derive it.
const FIXTURE: readonly AnyTool[] = Object.freeze([
  tool("read_file", "read", z.strictObject({ path: z.string(), offset: z.number().nullable() })),
  tool("write_file", "write"),
  tool("list_dir", "read"),
  tool("bash", "exec"),
  tool("grep", "read"),
  tool("current_time", "read"),
]);

describe("toJsonSchema", () => {
  it("emits a strict object schema without the $schema key", () => {
    const json = toJsonSchema(
      "read_file",
      z.strictObject({ path: z.string().describe("workspace path") }),
    );

    expect(json).toEqual({
      type: "object",
      properties: { path: { type: "string", description: "workspace path" } },
      required: ["path"],
      additionalProperties: false,
    });
    // Providers ignore it and it is pure noise in the cached prefix.
    expect(json).not.toHaveProperty("$schema");
  });

  it("keeps a nullable input required, which is how optionality is expressed", () => {
    const json = toJsonSchema("read_file", z.strictObject({ limit: z.number().nullable() }));
    expect(json.required).toEqual(["limit"]);
  });

  // The failure this exists to prevent is a provider 400 in the middle of
  // somebody's turn, with nothing pointing at the tool that caused it.
  it("refuses .optional(), naming the offending properties", () => {
    expect(() =>
      toJsonSchema("grep", z.strictObject({ pattern: z.string(), glob: z.string().optional() })),
    ).toThrow(/grep: glob used \.optional\(\)/);
  });

  it("refuses a schema that would let the model send anything", () => {
    // z.object and z.strictObject both emit additionalProperties: false under
    // zod's input view, so this is the case that actually differs.
    expect(() => toJsonSchema("grep", z.looseObject({ pattern: z.string() }))).toThrow(
      /must forbid extra properties/,
    );
    expect(() => toJsonSchema("grep", z.string())).toThrow(/must be an object/);
  });
});

describe("presets", () => {
  it("filters without reordering", () => {
    expect(selectPreset(FIXTURE, "standard").map((t) => t.name)).toEqual(
      FIXTURE.map((t) => t.name),
    );
    expect(selectPreset(FIXTURE, "readonly").map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
      "grep",
      "current_time",
    ]);
    expect(selectPreset(FIXTURE, "minimal").map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
      "grep",
      "current_time",
    ]);
  });

  it("excludes writing and executing tools from readonly", () => {
    const names = selectPreset(FIXTURE, "readonly").map((t) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
  });

  it("hands back a frozen array, so a caller cannot reorder it in place", () => {
    const tools = selectPreset(FIXTURE, "standard");
    expect(Object.isFrozen(tools)).toBe(true);
    expect(() => (tools as AnyTool[]).reverse()).toThrow();
  });
});

describe("buildSchemas", () => {
  it("produces one strict schema per tool, in the array's order", () => {
    const schemas = buildSchemas(FIXTURE);
    expect([...schemas.keys()]).toEqual(FIXTURE.map((t) => t.name));
    expect(schemas.get("read_file")).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "the read_file tool",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: {
              anyOf: [{ type: "number" }, { type: "null" }],
            },
          },
          required: ["path", "offset"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
  });

  // Two tools under one name makes the model's call ambiguous and silently
  // breaks the preset filters.
  it("refuses duplicate names", () => {
    expect(() => buildSchemas([tool("grep", "read"), tool("grep", "exec")])).toThrow(
      /duplicate tool name: grep/,
    );
  });

  // This is what makes a bad tool a boot failure rather than a turn failure.
  it("propagates a schema violation, which is what stops the server at boot", () => {
    expect(() =>
      buildSchemas([tool("grep", "read", z.strictObject({ x: z.string().optional() }))]),
    ).toThrow(/used \.optional\(\)/);
  });
});

describe("the prompt-cache canary", () => {
  it("serialises identically across calls", () => {
    // The tool block is the first thing in the cached prefix, so one changed
    // byte between two requests costs the whole turn's cache -- and nothing
    // about the reply looks wrong when it happens.
    const first = schemasFor("standard");
    const second = schemasFor("standard");

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Same object, not merely an equal one: the cache is what guarantees the
    // bytes cannot drift even if schema generation ever became non-pure.
    expect(second).toBe(first);
  });

  it("caches each preset separately and freezes what it returns", () => {
    expect(schemasFor("readonly")).toBe(schemasFor("readonly"));
    expect(toolsFor("minimal")).toBe(toolsFor("minimal"));
    expect(Object.isFrozen(schemasFor("standard"))).toBe(true);
  });

  it("draws every preset from the one frozen ALL array", () => {
    // Empty until the tools land in Stage 4; the invariant is that presets
    // never contain anything ALL does not.
    expect(Object.isFrozen(ALL)).toBe(true);
    for (const preset of ["standard", "readonly", "minimal"] as const) {
      for (const t of toolsFor(preset)) expect(ALL).toContain(t);
    }
  });
});
