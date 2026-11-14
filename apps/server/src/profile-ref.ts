import type { CliProviderId } from "@ucch/protocol";

/**
 * One subscription account of a subject (`agent_profiles`): the folder its
 * CLI's login lives in, under the subject's. The Default account's folder
 * is the provider's own name, so a subject that never named a second
 * account keeps the folder it always had.
 */
export interface ProfileRef {
  id: string;
  dirName: string;
}

/** Whether `profile` is the subject's Default account (or none was named). */
export function isDefaultProfile(id: CliProviderId, profile: ProfileRef | null | undefined): boolean {
  return !profile || profile.dirName === id;
}

/**
 * The key a profile's readings are kept under: the subject itself for its
 * Default account, so meters from before profiles read the same.
 */
export function profileKey(subject: string, id: CliProviderId, profile: ProfileRef | null | undefined): string {
  return isDefaultProfile(id, profile) ? subject : `${subject}/${profile!.id}`;
}
