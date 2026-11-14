import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { agentProfiles, projectProfileDefaults, type AgentProfile, type Database } from "@ucch/db";
import type { ProfileRef } from "./profile-ref.js";

/**
 * Named Claude Code and Codex subscription accounts (`agent_profiles`):
 * "Work" and "Personal" logins side by side, each in its own folder under
 * the subject's (`ProviderService.credsDir`).
 *
 * The rows hold labels and what the harness observed, never anything the
 * CLI's sign-in wrote. Moving a session between two accounts of one
 * provider is only ever a person's choice (`decide.ts`); nothing here picks
 * one by itself.
 */

export type ProfileProvider = "claude" | "codex";
export type ProfileContext = "personal" | "work";
export type ProfileAuthStatus = "unknown" | "signed_in" | "signed_out";

export const PROFILE_PROVIDERS: readonly ProfileProvider[] = ["claude", "codex"];
export const PROFILE_CONTEXTS: readonly ProfileContext[] = ["personal", "work"];
export const DEFAULT_PROFILE_LABEL = "Default";
export const PROFILE_LABEL_MAX = 40;
/** More than anyone signs in to, few enough that a list of them stays a list. */
export const PROFILES_PER_PROVIDER_MAX = 8;

/** When a limit gave no reset time, how long the account is treated as limited. */
export const ESTIMATED_LIMIT_MS = 5 * 60 * 60_000;

export function isProfileProvider(value: unknown): value is ProfileProvider {
  return value === "claude" || value === "codex";
}

export function isProfileContext(value: unknown): value is ProfileContext {
  return value === "personal" || value === "work";
}

/** What a session, a card or a picker needs of a profile. */
export interface ProfileView {
  id: string;
  subject: string;
  provider: ProfileProvider;
  label: string;
  context: ProfileContext;
  isDefault: boolean;
  authStatus: ProfileAuthStatus;
  /** ISO, while limited; null otherwise. */
  limitedUntil: string | null;
  limitEstimated: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export function isDefaultRow(row: Pick<AgentProfile, "dirName" | "provider">): boolean {
  return row.dirName === row.provider;
}

export function toRef(row: Pick<AgentProfile, "id" | "dirName">): ProfileRef {
  return { id: row.id, dirName: row.dirName };
}

/** Limited while the reset time is still ahead: no job has to clear it. */
export function limitedUntil(row: Pick<AgentProfile, "limitResetsAt">, now = Date.now()): Date | null {
  return row.limitResetsAt && row.limitResetsAt.getTime() > now ? row.limitResetsAt : null;
}

export function toView(row: AgentProfile, now = Date.now()): ProfileView {
  const until = limitedUntil(row, now);
  return {
    id: row.id,
    subject: row.subject,
    provider: row.provider as ProfileProvider,
    label: row.label,
    context: (isProfileContext(row.context) ? row.context : "personal"),
    isDefault: isDefaultRow(row),
    authStatus: (["signed_in", "signed_out"].includes(row.authStatus) ? row.authStatus : "unknown") as ProfileAuthStatus,
    limitedUntil: until?.toISOString() ?? null,
    limitEstimated: until ? row.limitEstimated : false,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A label as stored: trimmed, single-spaced, or null when it is not one. */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim().replace(/\s+/g, " ");
  return label.length >= 1 && label.length <= PROFILE_LABEL_MAX ? label : null;
}

/**
 * Whether a project that asks for `required` accepts an account tagged
 * `context`. A project that asks for nothing accepts any.
 */
export function contextAllowed(required: string | null | undefined, context: string): boolean {
  return !required || required === context;
}

export class ProfileError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

export class AgentProfiles {
  constructor(
    private readonly db: Database,
    /** Makes a new account's folder, `0700`, before its first sign-in. */
    private readonly makeDir: (subject: string, provider: ProfileProvider, profile: ProfileRef) => void,
    /** Removes a deleted account's folder, login and all. */
    private readonly removeDir: (subject: string, provider: ProfileProvider, profile: ProfileRef) => Promise<void>,
  ) {}

  /**
   * A subject's accounts, Default first, then by age. The Default row of
   * each provider is made here the first time, pointing at the folder the
   * subject's login already used: nothing on disk moves.
   */
  async list(subject: string, provider?: ProfileProvider): Promise<AgentProfile[]> {
    await Promise.all((provider ? [provider] : PROFILE_PROVIDERS).map((p) => this.#ensureDefault(subject, p)));
    const rows = await this.db
      .select()
      .from(agentProfiles)
      .where(provider ? and(eq(agentProfiles.subject, subject), eq(agentProfiles.provider, provider)) : eq(agentProfiles.subject, subject))
      .orderBy(asc(agentProfiles.createdAt));
    return rows.sort((a, b) => Number(isDefaultRow(b)) - Number(isDefaultRow(a)));
  }

  async get(id: string): Promise<AgentProfile | null> {
    const [row] = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).limit(1);
    return row ?? null;
  }

  /** The profile when it is `subject`'s own; never another subject's. */
  async owned(id: string, subject: string): Promise<AgentProfile | null> {
    const row = await this.get(id);
    return row && row.subject === subject ? row : null;
  }

  async defaultFor(subject: string, provider: ProfileProvider): Promise<AgentProfile> {
    return this.#ensureDefault(subject, provider);
  }

  async create(subject: string, provider: ProfileProvider, input: { label: unknown; context?: unknown }): Promise<AgentProfile> {
    const label = cleanLabel(input.label);
    if (!label) throw new ProfileError("invalid", `Name the account in 1 to ${PROFILE_LABEL_MAX} characters.`);
    const context = input.context === undefined ? "personal" : input.context;
    if (!isProfileContext(context)) throw new ProfileError("invalid", "An account is tagged personal or work.");
    const existing = await this.list(subject, provider);
    if (existing.length >= PROFILES_PER_PROVIDER_MAX) {
      throw new ProfileError("conflict", `At most ${PROFILES_PER_PROVIDER_MAX} accounts per provider.`);
    }
    if (existing.some((row) => row.label.toLowerCase() === label.toLowerCase())) {
      throw new ProfileError("conflict", `There is already an account named "${label}".`);
    }
    // Random rather than the row id, so the folder is named before the row
    // exists and a reused label never lands in an old login's folder.
    const dirName = `${provider}-${randomBytes(6).toString("hex")}`;
    const [row] = await this.db
      .insert(agentProfiles)
      .values({ subject, provider, label, context, dirName })
      .returning();
    this.makeDir(subject, provider, toRef(row!));
    return row!;
  }

  async update(row: AgentProfile, input: { label?: unknown; context?: unknown }): Promise<AgentProfile> {
    const patch: Partial<Pick<AgentProfile, "label" | "context">> = {};
    if (input.label !== undefined) {
      const label = cleanLabel(input.label);
      if (!label) throw new ProfileError("invalid", `Name the account in 1 to ${PROFILE_LABEL_MAX} characters.`);
      const clash = (await this.list(row.subject, row.provider as ProfileProvider)).some(
        (other) => other.id !== row.id && other.label.toLowerCase() === label.toLowerCase(),
      );
      if (clash) throw new ProfileError("conflict", `There is already an account named "${label}".`);
      patch.label = label;
    }
    if (input.context !== undefined) {
      if (!isProfileContext(input.context)) throw new ProfileError("invalid", "An account is tagged personal or work.");
      patch.context = input.context;
    }
    if (Object.keys(patch).length === 0) return row;
    const [updated] = await this.db.update(agentProfiles).set(patch).where(eq(agentProfiles.id, row.id)).returning();
    return updated ?? row;
  }

  /**
   * Deletes a named account and its folder. Its sessions fall back to the
   * project's default or the Default account (`threads.profile_id` is set
   * null); the Default account itself is only ever signed out.
   */
  async remove(row: AgentProfile): Promise<void> {
    if (isDefaultRow(row)) throw new ProfileError("forbidden", "The Default account cannot be deleted; sign it out instead.");
    await this.removeDir(row.subject, row.provider as ProfileProvider, toRef(row));
    await this.db.delete(agentProfiles).where(eq(agentProfiles.id, row.id));
  }

  async setAuthStatus(id: string, status: ProfileAuthStatus): Promise<void> {
    await this.db.update(agentProfiles).set({ authStatus: status }).where(eq(agentProfiles.id, id));
  }

  /**
   * A turn on this account hit the plan's limit. `resetsAt` is the CLI's
   * own word; without one the account counts as limited for five hours,
   * said to be a guess.
   */
  async markLimited(id: string, resetsAt: Date | null, now = Date.now()): Promise<Date> {
    const at = resetsAt && resetsAt.getTime() > now ? resetsAt : new Date(now + ESTIMATED_LIMIT_MS);
    await this.db
      .update(agentProfiles)
      .set({ limitResetsAt: at, limitEstimated: !resetsAt || resetsAt.getTime() <= now })
      .where(eq(agentProfiles.id, id));
    return at;
  }

  async touch(id: string, now = new Date()): Promise<void> {
    await this.db.update(agentProfiles).set({ lastUsedAt: now }).where(eq(agentProfiles.id, id));
  }

  /** The account a person's new sessions in a project use, if they chose one. */
  async projectDefault(projectId: string, userId: string, provider: ProfileProvider): Promise<string | null> {
    const [row] = await this.db
      .select({ profileId: projectProfileDefaults.profileId })
      .from(projectProfileDefaults)
      .where(
        and(
          eq(projectProfileDefaults.projectId, projectId),
          eq(projectProfileDefaults.userId, userId),
          eq(projectProfileDefaults.provider, provider),
        ),
      )
      .limit(1);
    return row?.profileId ?? null;
  }

  async projectDefaults(projectId: string, userId: string): Promise<Partial<Record<ProfileProvider, string>>> {
    const rows = await this.db
      .select({ provider: projectProfileDefaults.provider, profileId: projectProfileDefaults.profileId })
      .from(projectProfileDefaults)
      .where(and(eq(projectProfileDefaults.projectId, projectId), eq(projectProfileDefaults.userId, userId)));
    const out: Partial<Record<ProfileProvider, string>> = {};
    for (const row of rows) if (isProfileProvider(row.provider)) out[row.provider] = row.profileId;
    return out;
  }

  /** Sets, or with null clears, a person's default account for a project. */
  async setProjectDefault(projectId: string, userId: string, provider: ProfileProvider, profileId: string | null): Promise<void> {
    const where = and(
      eq(projectProfileDefaults.projectId, projectId),
      eq(projectProfileDefaults.userId, userId),
      eq(projectProfileDefaults.provider, provider),
    );
    if (!profileId) {
      await this.db.delete(projectProfileDefaults).where(where);
      return;
    }
    await this.db
      .insert(projectProfileDefaults)
      .values({ projectId, userId, provider, profileId })
      .onConflictDoUpdate({
        target: [projectProfileDefaults.projectId, projectProfileDefaults.userId, projectProfileDefaults.provider],
        set: { profileId },
      });
  }

  async #ensureDefault(subject: string, provider: ProfileProvider): Promise<AgentProfile> {
    const where = and(eq(agentProfiles.subject, subject), eq(agentProfiles.dirName, provider));
    const [found] = await this.db.select().from(agentProfiles).where(where).limit(1);
    if (found) return found;
    await this.db
      .insert(agentProfiles)
      .values({ subject, provider, label: DEFAULT_PROFILE_LABEL, dirName: provider })
      .onConflictDoNothing();
    const [row] = await this.db.select().from(agentProfiles).where(where).limit(1);
    if (!row) throw new Error(`Could not make the Default ${provider} account for ${subject}`);
    return row;
  }
}
