import { describe, expect, it } from "vitest";
import { gitSubcommand } from "./git-exec.js";

describe("gitSubcommand", () => {
  it("finds the subcommand after the options", () => {
    expect(gitSubcommand(["status", "--porcelain=v2"])).toBe("status");
    expect(gitSubcommand(["--no-pager", "log", "-n", "5"])).toBe("log");
  });

  it("never mistakes a -c or -C value for it", () => {
    // The commit identity is a person's name: it must not become a label.
    expect(gitSubcommand(["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "commit", "-m", "x"])).toBe(
      "commit",
    );
    expect(gitSubcommand(["-C", "/data/workspaces/p", "rev-parse", "HEAD"])).toBe("rev-parse");
  });

  it("names a command line with no subcommand as other", () => {
    expect(gitSubcommand([])).toBe("other");
    expect(gitSubcommand(["-c", "x=y"])).toBe("other");
  });
});
