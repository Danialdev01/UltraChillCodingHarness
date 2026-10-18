import { describe, expect, it } from "vitest";
import { matchCommands, matchOptions, SLASH_COMMANDS, slashAt } from "./slash-commands.js";

describe("finding the command at the caret", () => {
  it("reads the name, then the argument after a space", () => {
    expect(slashAt("/", 1)).toEqual({ name: "", arg: null });
    expect(slashAt("/mo", 3)).toEqual({ name: "mo", arg: null });
    expect(slashAt("/model son", 10)).toEqual({ name: "model", arg: "son" });
    expect(slashAt("/model ", 7)).toEqual({ name: "model", arg: "" });
  });

  it("only opens at the start of the first line", () => {
    expect(slashAt("see /usr", 8)).toBeNull();
    expect(slashAt("/a\nb", 4)).toBeNull();
    expect(slashAt("/abc", 0)).toBeNull();
  });
});

describe("matching", () => {
  it("puts commands that start with the query first", () => {
    expect(matchCommands(SLASH_COMMANDS, "e").map((c) => c.name)).toEqual(["effort", "clear", "model", "harness", "research", "documentation"]);
    expect(matchCommands(SLASH_COMMANDS, "cl").map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands(SLASH_COMMANDS, "zz")).toEqual([]);
  });

  it("returns everything for an empty query", () => {
    expect(matchOptions(["a", "b"], " ", (s) => s)).toEqual(["a", "b"]);
  });
});
