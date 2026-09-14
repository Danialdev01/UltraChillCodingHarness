import { z } from "zod/v4";

/**
 * Making a model's tool arguments fit the schema it was given.
 *
 * Every tool input is a strict object whose every property is required --
 * `schema.ts` explains why -- and the strongest models honour that. Weaker
 * and cheaper ones do not: they quote numbers ("5000"), quote booleans, send
 * a nested object as a JSON string, or leave a nullable property out
 * altogether. None of that is ambiguous, and none of it is worth failing a
 * turn over: the harness knows exactly what type it asked for, so it can
 * repair the call rather than bouncing it back and watching the model make
 * the same mistake three more times.
 *
 * The repairs are deliberately narrow. Each one is driven by a type error
 * zod actually reported, converts losslessly, and is kept only if the value
 * then validates -- so nothing here can invent an argument the model did not
 * send or turn a genuinely wrong call into a plausible-looking one.
 */

export type ParsedArguments<I> =
  | { ok: true; value: I; repairs: readonly string[] }
  | { ok: false; message: string };

/**
 * A second pass catches what the first uncovers -- a JSON string decoded
 * into an object can hold a quoted number of its own -- and a third is
 * already generous. Bounded so a schema that cannot be satisfied cannot spin.
 */
const MAX_PASSES = 3;

/**
 * Validates the model's arguments, repairing the type slips that are safe to
 * repair.
 *
 * Returns the repairs it made so the caller can log them; they are not shown
 * to the model, which would be noise in every transcript for something the
 * harness has already dealt with.
 */
export function parseToolArguments<I>(
  name: string,
  schema: z.ZodType<I>,
  raw: unknown,
): ParsedArguments<I> {
  // A whole argument object sent as a JSON string, which some providers do
  // when a model double-encodes its own call.
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    const decoded = decodeJson(candidate);
    if (isRecord(decoded)) candidate = decoded;
  }

  const repairs: string[] = [];

  for (let pass = 0; ; pass++) {
    const result = schema.safeParse(candidate);
    if (result.success) return { ok: true, value: result.data, repairs };
    if (pass >= MAX_PASSES) return { ok: false, message: explain(name, schema, result.error) };

    const next = applyRepairs(candidate, result.error.issues, repairs);
    // Nothing repairable left: the arguments are wrong in a way no amount of
    // coercion fixes, so report them rather than looping to the pass limit.
    if (next === null) return { ok: false, message: explain(name, schema, result.error) };
    candidate = next;
  }
}

/**
 * One pass of repairs, or null when none of the issues is repairable.
 *
 * The value is copied rather than edited in place: the caller's object is
 * the one recorded in the event log as what the model actually sent, and
 * that record must not change because the harness patched a copy of it.
 */
function applyRepairs(
  candidate: unknown,
  issues: readonly z.core.$ZodIssue[],
  repairs: string[],
): unknown {
  if (!isRecord(candidate) && !Array.isArray(candidate)) return null;

  const draft = structuredClone(candidate) as Record<string, unknown>;
  let repaired = false;

  for (const issue of issues) {
    if (issue.code !== "invalid_type" || issue.path.length === 0) continue;

    const path = issue.path as (string | number)[];
    const current = readPath(draft, path);
    const fixed = coerce(issue.expected, current);
    if (fixed === undefined) continue;

    if (writePath(draft, path, fixed.value)) {
      repairs.push(`${path.join(".")}: ${show(current)} -> ${show(fixed.value)}`);
      repaired = true;
    }
  }

  return repaired ? draft : null;
}

/**
 * The one value a property of this type could have been meant as, if any.
 *
 * `undefined` as the answer means "no repair"; a missing property is
 * repaired to null, which validates for exactly the properties that were
 * declared nullable and fails again for the ones that were not.
 */
function coerce(expected: string, value: unknown): { value: unknown } | undefined {
  if (value === undefined) return { value: null };

  switch (expected) {
    case "number":
    case "int":
    case "bigint": {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      // Deliberately not `Number(value)`: that reads "" as 0, " 12 " as 12
      // and "0x10" as 16, none of which a model meant to type.
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { value: parsed } : undefined;
    }

    case "boolean": {
      if (typeof value !== "string") return undefined;
      const lowered = value.trim().toLowerCase();
      if (lowered === "true") return { value: true };
      if (lowered === "false") return { value: false };
      return undefined;
    }

    case "string":
      // The other direction: a path or a piece of content sent as a bare
      // number. Objects are excluded -- "[object Object]" is not a repair.
      return typeof value === "number" || typeof value === "boolean"
        ? { value: String(value) }
        : undefined;

    case "array":
    case "object": {
      if (typeof value !== "string") return undefined;
      const decoded = decodeJson(value);
      const matches = expected === "array" ? Array.isArray(decoded) : isRecord(decoded);
      return matches ? { value: decoded } : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * What to tell the model when the arguments cannot be salvaged.
 *
 * The failures are listed, and then the whole call shape is restated with
 * each property's type. A model that has just miscalled a tool is exactly
 * the model that will not re-derive the shape from the schema it was given
 * several thousand tokens ago, and repeating the same broken call is the
 * expensive failure this message exists to prevent.
 */
function explain(name: string, schema: z.ZodType, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return (
    `The arguments for ${name} do not match its schema: ${issues}. ` +
    `Call it with a JSON object containing every property: ${signature(schema)}. ` +
    `Send numbers and booleans unquoted, and pass null for a property you do not need.`
  );
}

/** `command (string), timeout_ms (number or null)`, from the tool's schema. */
function signature(schema: z.ZodType): string {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema) as Record<string, unknown>;
  } catch {
    // A schema that cannot be described is not a reason to lose the issue
    // list, which is the part that says what went wrong.
    return "see the tool's schema";
  }

  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const entries = Object.entries(properties).map(([key, node]) => `${key} (${typeName(node)})`);
  return entries.length > 0 ? entries.join(", ") : "no arguments";
}

/** A JSON Schema node as a type word: `string`, `number or null`, `unknown`. */
function typeName(node: unknown): string {
  if (!isRecord(node)) return "unknown";

  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) return node.type.map(String).join(" or ");

  // `.nullable()` becomes an anyOf of the type and null, which is the shape
  // every optional tool input has.
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    const names = [...new Set(variants.map(typeName))];
    return names.join(" or ");
  }

  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  return "unknown";
}

function readPath(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

/** Writes through an existing path only; it never creates the way in. */
function writePath(root: unknown, path: readonly (string | number)[], value: unknown): boolean {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(node) && !Array.isArray(node)) return false;
    node = (node as Record<string | number, unknown>)[key];
  }
  if (!isRecord(node) && !Array.isArray(node)) return false;
  (node as Record<string | number, unknown>)[path[path.length - 1]!] = value;
  return true;
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short enough for a log line: a repair is not worth 40KB of content. */
function show(value: unknown): string {
  if (value === undefined) return "(missing)";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
