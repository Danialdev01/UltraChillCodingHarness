import { z } from "zod/v4";

/**
 * A tool as offered to the model, in the provider's shape.
 *
 * Declared here rather than imported from the server's transport module:
 * this package must not depend on `apps/server`, and the two are
 * structurally identical, so one satisfies the other at every call site.
 */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: true;
  };
}

/**
 * Converts a tool's zod input schema to the JSON Schema the API wants.
 *
 * No new dependency: the pinned zod ships `zod/v4` with a native
 * `toJSONSchema`, which emits `additionalProperties: false` for
 * `z.strictObject` -- precisely what `strict: true` requires.
 *
 * `$schema` is stripped. Providers ignore it, it is pure noise in the
 * cached prefix, and the prefix is the first thing in every request.
 */
export function toJsonSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  assertStrict(name, json);
  return json;
}

/**
 * Refuses a schema `strict: true` would reject.
 *
 * Strict mode demands that every property appear in `required`, so tool
 * inputs express optionality as `.nullable()` and never `.optional()`. This
 * runs while the registry module is being evaluated, so a malformed tool
 * stops the server at boot rather than surfacing as a provider 400 in the
 * middle of somebody's turn -- which would be a failure with no obvious
 * connection to the tool that caused it.
 */
function assertStrict(name: string, json: Record<string, unknown>): void {
  if (json.type !== "object") {
    throw new Error(`tool ${name}: input schema must be an object, got ${String(json.type)}`);
  }
  // `z.object` and `z.strictObject` both emit this under zod's input view;
  // `z.looseObject` is the one that does not, and a tool declared with it
  // would offer the model a schema that permits anything.
  if (json.additionalProperties !== false) {
    throw new Error(
      `tool ${name}: input schema must forbid extra properties -- ` +
        `use z.strictObject, not z.looseObject`,
    );
  }

  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const required = new Set((json.required ?? []) as string[]);
  const optional = Object.keys(properties).filter((key) => !required.has(key));

  if (optional.length > 0) {
    throw new Error(
      `tool ${name}: ${optional.join(", ")} used .optional(); strict mode requires every ` +
        `property in "required", so express an optional input as .nullable()`,
    );
  }
}
