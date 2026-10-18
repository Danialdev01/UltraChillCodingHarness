import { describe, expect, it } from "vitest";
import { admitGithubUser, type Applicant } from "./github-admission.js";

const applicant = (over: Partial<Applicant> = {}): Applicant => ({
  login: "Octocat",
  existing: false,
  isOrgMember: async () => false,
  ...over,
});

describe("admitGithubUser", () => {
  it("closes sign-up when no allowlist is configured", async () => {
    const open = { allowedUsers: [], allowedOrgs: [] };
    expect(await admitGithubUser(open, applicant())).toBe(false);
    expect(await admitGithubUser(open, applicant({ existing: true }))).toBe(true);
  });

  it("admits a listed login, case-insensitively", async () => {
    const policy = { allowedUsers: ["octocat"], allowedOrgs: [] };
    expect(await admitGithubUser(policy, applicant())).toBe(true);
    expect(await admitGithubUser(policy, applicant({ login: "someone-else" }))).toBe(false);
  });

  it("admits a member of a listed organisation", async () => {
    const policy = { allowedUsers: [], allowedOrgs: ["acme"] };
    const member = applicant({ isOrgMember: async (org) => org === "acme" });
    expect(await admitGithubUser(policy, member)).toBe(true);
    expect(await admitGithubUser(policy, applicant())).toBe(false);
  });

  it("does not let an existing account bypass a configured allowlist", async () => {
    const policy = { allowedUsers: ["octocat"], allowedOrgs: [] };
    expect(await admitGithubUser(policy, applicant({ login: "removed", existing: true }))).toBe(false);
  });
});
