import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { parseToolArguments } from "./arguments.js";

const schema = z.strictObject({
  command: z.string(),
  timeout_ms: z.number().int().min(1_000).nullable(),
  quiet: z.boolean().nullable(),
  env: z.array(z.string()).nullable(),
});

const parse = (raw: unknown) => parseToolArguments("bash", schema, raw);

/** The parsed value, or the failure message, whichever came back. */
function value(raw: unknown): unknown {
  const result = parse(raw);
  return result.ok ? result.value : result.message;
}

describe("what a well-behaved model sends", () => {
  it("passes through untouched, with no repairs recorded", () => {
    const input = { command: "ls", timeout_ms: 5000, quiet: false, env: ["A=1"] };
    const result = parse(input);

    expect(result).toMatchObject({ ok: true, value: input });
    expect(result.ok && result.repairs).toEqual([]);
  });
});

describe("the slips a smaller model makes", () => {
  it("unquotes a number", () => {
    expect(value({ command: "ls", timeout_ms: "5000", quiet: null, env: null })).toMatchObject({
      timeout_ms: 5000,
    });
  });

  it("unquotes a boolean, in either case", () => {
    expect(value({ command: "ls", timeout_ms: null, quiet: "TRUE", env: null })).toMatchObject({
      quiet: true,
    });
    expect(value({ command: "ls", timeout_ms: null, quiet: "false", env: null })).toMatchObject({
      quiet: false,
    });
  });

  it("reads a nullable property that was left out as null", () => {
    expect(value({ command: "ls" })).toEqual({
      command: "ls",
      timeout_ms: null,
      quiet: null,
      env: null,
    });
  });

  it("decodes an array sent as a JSON string", () => {
    expect(value({ command: "ls", timeout_ms: null, quiet: null, env: '["A=1"]' })).toMatchObject({
      env: ["A=1"],
    });
  });

  it("decodes the whole argument object sent as a JSON string", () => {
    expect(value(JSON.stringify({ command: "ls" }))).toMatchObject({ command: "ls" });
  });

  it("stringifies a number where a string was asked for", () => {
    expect(value({ command: 42, timeout_ms: null, quiet: null, env: null })).toMatchObject({
      command: "42",
    });
  });

  it("says what it changed", () => {
    const result = parse({ command: "ls", timeout_ms: "5000" });
    expect(result.ok && result.repairs).toEqual([
      'timeout_ms: "5000" -> 5000',
      "quiet: (missing) -> null",
      "env: (missing) -> null",
    ]);
  });
});

describe("what it refuses to repair", () => {
  it("does not invent a required property that was never sent", () => {
    const result = parse({ timeout_ms: 5000 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/command/);
  });

  it("does not read a string that only looks numeric", () => {
    // "" as 0 and "0x10" as 16 are JavaScript's conversions, not a model's
    // intent, and a timeout invented out of an empty string is worse than
    // an error that says the timeout was wrong.
    for (const bad of ["", "  ", "0x10", "1e3", "5 seconds"]) {
      expect(parse({ command: "ls", timeout_ms: bad, quiet: null, env: null }).ok).toBe(false);
    }
  });

  it("does not read a word as a boolean", () => {
    expect(parse({ command: "ls", timeout_ms: null, quiet: "yes", env: null }).ok).toBe(false);
  });

  it("leaves a value that is wrong rather than mistyped alone", () => {
    // 10 is a number, so nothing is coerced; it simply breaks the minimum,
    // and the model is told that rather than handed a silently raised value.
    const result = parse({ command: "ls", timeout_ms: 10, quiet: null, env: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/1000/);
  });

  it("does not stringify an object into a path", () => {
    const one = z.strictObject({ path: z.string() });
    expect(parseToolArguments("read_file", one, { path: { file: "a.ts" } }).ok).toBe(false);
  });
});

describe("the message a failure produces", () => {
  it("lists the failures, then restates the whole call shape", () => {
    const result = parse({ timeout_ms: 10 });
    const message = result.ok === false ? result.message : "";

    expect(message).toMatch(/do not match its schema/);
    expect(message).toMatch(/command \(string\)/);
    expect(message).toMatch(/timeout_ms \(integer or null\)/);
    expect(message).toMatch(/env \(array or null\)/);
    expect(message).toMatch(/unquoted/);
  });
});

describe("nested arguments", () => {
  const nested = z.strictObject({
    edits: z.array(z.strictObject({ path: z.string(), line: z.number().int() })),
  });

  it("repairs inside an array of objects", () => {
    const result = parseToolArguments("edit", nested, { edits: [{ path: "a.ts", line: "3" }] });
    expect(result).toMatchObject({ ok: true, value: { edits: [{ path: "a.ts", line: 3 }] } });
  });

  it("repairs a nested object that arrived as a JSON string", () => {
    const result = parseToolArguments("edit", nested, {
      edits: '[{"path":"a.ts","line":"3"}]',
    });
    expect(result).toMatchObject({ ok: true, value: { edits: [{ path: "a.ts", line: 3 }] } });
  });

  it("never mutates what the model actually sent", () => {
    // The raw arguments are what the event log records; a repair works on a
    // copy so the log keeps saying what really came over the wire.
    const raw = { command: "ls", timeout_ms: "5000" };
    parse(raw);
    expect(raw).toEqual({ command: "ls", timeout_ms: "5000" });
  });
});
