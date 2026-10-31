import { describe, expect, it } from "vitest";
import { projectRoot, sessionTree, treeFor, worktreeIdOf } from "./trees.js";

const ROOT = "/w";
const PROJECT = "55555555-5555-5555-5555-555555555555";

describe("treeFor", () => {
  it("is a session's own worktree once it is ready, the checkout before", () => {
    const thread = { projectId: PROJECT, hash: "s3ss10nhash0", worktreeState: "ready" };
    expect(treeFor(ROOT, PROJECT, thread)).toBe(sessionTree(ROOT, PROJECT, "s3ss10nhash0"));
    expect(treeFor(ROOT, PROJECT, { ...thread, worktreeState: "creating" })).toBe(projectRoot(ROOT, PROJECT));
    expect(treeFor(ROOT, PROJECT, null)).toBe(projectRoot(ROOT, PROJECT));
  });

  it("is the old session's worktree for one a handoff started, and tells its changes under that one's id", () => {
    const thread = { projectId: PROJECT, hash: "n3wsess10n00", worktreeState: "ready", treeHash: "s3ss10nhash0" };
    const tree = treeFor(ROOT, PROJECT, thread);
    expect(tree).toBe(sessionTree(ROOT, PROJECT, "s3ss10nhash0"));
    expect(worktreeIdOf(ROOT, { projectId: PROJECT, tree })).toBe("s3ss10nhash0");
  });
});
