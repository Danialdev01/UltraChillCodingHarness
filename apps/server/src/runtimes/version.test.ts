import { describe, expect, it } from "vitest";

import { linesOf, matchesSelection, newestFirst, parseVersion, pickVersion, satisfiesConstraint } from "./version.js";

describe("versions", () => {
  it("parses only full x.y.z", () => {
    expect(parseVersion("8.4.12")).toEqual([8, 4, 12]);
    expect(parseVersion("8.4")).toBeNull();
    expect(parseVersion("8.4.0RC1")).toBeNull();
  });

  it("sorts numerically, not as text", () => {
    expect(newestFirst(["8.4.9", "8.4.10", "8.3.30", "8.4.10", "junk"])).toEqual(["8.4.10", "8.4.9", "8.3.30"]);
    expect(linesOf(["8.4.9", "8.5.1", "8.4.10"])).toEqual(["8.5", "8.4"]);
  });

  it("picks what a selection means", () => {
    const installed = ["8.3.30", "8.4.9", "8.4.12", "8.5.1"];
    expect(pickVersion("latest", installed)).toBe("8.5.1");
    expect(pickVersion("8.4", installed)).toBe("8.4.12");
    expect(pickVersion("8.4.9", installed)).toBe("8.4.9");
    expect(pickVersion("8.2", installed)).toBeNull();
    expect(pickVersion("8.4.1", installed)).toBeNull();
    expect(pickVersion("system", installed)).toBeNull();
    expect(matchesSelection("8.4", "8.40.1")).toBe(false);
  });
});

describe("composer constraints", () => {
  const cases: Array<[string, string, boolean | null]> = [
    ["^8.1", "8.1.0", true],
    ["^8.1", "8.4.12", true],
    ["^8.1", "8.0.30", false],
    ["^8.1", "9.0.0", false],
    ["^8.2 || ^8.3", "8.3.1", true],
    ["^7.4|^8.0", "8.2.0", true],
    [">=8.1 <8.4", "8.3.99", true],
    [">=8.1 <8.4", "8.4.0", false],
    [">= 8.1, < 8.4", "8.2.0", true],
    ["~8.1", "8.9.0", true],
    ["~8.1.2", "8.2.0", false],
    ["~8.1.2", "8.1.9", true],
    ["8.1.*", "8.1.5", true],
    ["8.1.*", "8.2.0", false],
    ["8.1", "8.1.7", true],
    ["8.1 - 8.3", "8.3.20", true],
    ["8.1 - 8.3", "8.4.0", false],
    ["*", "8.4.0", true],
    [">=8.2@dev", "8.2.0", true],
    ["dev-main", "8.2.0", null],
  ];
  it.each(cases)("%s against %s", (constraint, version, expected) => {
    expect(satisfiesConstraint(constraint, version)).toBe(expected);
  });
});
