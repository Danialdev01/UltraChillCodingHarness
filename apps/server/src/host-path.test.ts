import { describe, expect, it } from "vitest";
import { mergePath, parseMarkedPath } from "./host-path.js";

describe("parseMarkedPath", () => {
  it("reads the PATH between the markers, whatever the rc files printed around it", () => {
    const out = "Welcome to fish!\n\x1b[32mmotd\x1b[0m\n\x1fUCCH_PATH/home/u/.local/bin:/usr/bin\x1ftrailing";
    expect(parseMarkedPath(out)).toBe("/home/u/.local/bin:/usr/bin");
  });

  it("is null when the shell printed no marked PATH", () => {
    expect(parseMarkedPath("")).toBeNull();
    expect(parseMarkedPath("\x1fUCCH_PATH/usr/bin")).toBeNull();
    expect(parseMarkedPath("\x1fUCCH_PATH\x1f")).toBeNull();
  });
});

describe("mergePath", () => {
  const exists = (path: string) => path === "/home/u/.claude/local" || path === "/usr/local/bin";

  it("keeps today's entries first, then the login shell's, then existing install dirs", () => {
    expect(mergePath("/usr/bin:/bin", "/home/u/.npm/bin:/usr/bin", "/home/u", exists)).toBe(
      "/usr/bin:/bin:/home/u/.npm/bin:/home/u/.claude/local:/usr/local/bin",
    );
  });

  it("drops duplicates and empty entries", () => {
    expect(mergePath("/usr/bin::/usr/local/bin", null, "/home/u", exists)).toBe(
      "/usr/bin:/usr/local/bin:/home/u/.claude/local",
    );
  });

  it("copes with no PATH at all", () => {
    expect(mergePath(undefined, null, "/home/u", () => false)).toBe("");
  });
});
