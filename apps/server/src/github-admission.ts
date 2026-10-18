/**
 * Who GitHub sign-in lets in.
 *
 * Every account here gets a terminal and an agent that runs commands, so a
 * GitHub account on its own is not a reason to create one. An operator names
 * logins or organisations; with neither named, only accounts that already
 * exist may sign in again.
 */

export interface AdmissionPolicy {
  /** Lower-cased GitHub logins. */
  allowedUsers: readonly string[];
  /** Lower-cased GitHub organisation names. */
  allowedOrgs: readonly string[];
}

export interface Applicant {
  login: string;
  /** Whether this GitHub identity already has an account here. */
  existing: boolean;
  /**
   * Asks GitHub whether the applicant is an active member of `org`. Only
   * called when an organisation list is configured and nothing else admitted.
   */
  isOrgMember: (org: string) => Promise<boolean>;
}

export async function admitGithubUser(policy: AdmissionPolicy, applicant: Applicant): Promise<boolean> {
  const restricted = policy.allowedUsers.length > 0 || policy.allowedOrgs.length > 0;
  // No list at all: sign-in still works for whoever was let in before, and
  // sign-up is closed.
  if (!restricted) return applicant.existing;

  if (policy.allowedUsers.includes(applicant.login.toLowerCase())) return true;
  for (const org of policy.allowedOrgs) {
    if (await applicant.isOrgMember(org)) return true;
  }
  return false;
}
