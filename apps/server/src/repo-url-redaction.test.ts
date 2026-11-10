import { describe, expect, it } from "vitest";
import { repoLabel } from "./session-routes.js";
import { withoutCredentials } from "./workspaces.js";

describe("repository URLs on their way to a browser", () => {
  it("lose any credentials stored in them", () => {
    expect(withoutCredentials("https://oauth2:glpat-secret@gitlab.com/team/ams.git")).toBe("https://gitlab.com/team/ams.git");
    expect(withoutCredentials("https://x-access-token:ghp_x@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(withoutCredentials("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("become a host/owner/name label, credentials and all left out", () => {
    expect(repoLabel("https://oauth2:glpat-secret@gitlab.com/team/ams.git")).toBe("gitlab.com/team/ams");
    expect(repoLabel("git@github.com:Danialdev01/StoryTypingTest.git")).toBe("github.com/Danialdev01/StoryTypingTest");
    expect(repoLabel(null)).toBeNull();
  });
});
