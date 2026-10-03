import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { auditLog, users, type Database } from "@ucch/db";
import type { AuditEntry, DomainEvent } from "@ucch/protocol";

/** How long repeated saves of one thing by one person keep folding into one line. */
export const COALESCE_WINDOW_MS = 5 * 60 * 1000;

export interface AuditInput {
  /** Null for a change to the account rather than to a project. */
  projectId: string | null;
  userId: string | null;
  clientId: string | null;
  /** `note.update`, `file.write`, `chat.send`, ... */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** One line a person reads: "Edited “Roadmap”". */
  summary: string;
  details?: Record<string, unknown>;
  /**
   * Fold into the same person's last line for the same action on the same
   * target, if it is recent. For saves that arrive as fast as typing.
   */
  coalesce?: boolean;
}

/** Details whose numbers add up across coalesced saves rather than being replaced. */
const ACCUMULATED = new Set(["charsAdded", "charsRemoved", "saves"]);

/**
 * The later save's details over the earlier one's, with the running totals
 * added rather than overwritten -- a paragraph typed over forty saves reads
 * as the paragraph, not as the last word.
 */
export function mergeDetails(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...before, ...after };
  for (const key of ACCUMULATED) {
    const a = before[key];
    const b = after[key];
    if (typeof a === "number" && typeof b === "number") merged[key] = a + b;
  }
  // The first value of something renamed is the one worth keeping.
  if ("from" in before) merged.from = before.from;
  return merged;
}

/** Whether a new entry folds into an earlier one updated at `lastAt`. */
export function withinWindow(lastAt: Date, now: Date): boolean {
  return now.getTime() - lastAt.getTime() < COALESCE_WINDOW_MS;
}

/**
 * The project's history of who changed what.
 *
 * Writing an entry never fails the change it describes: `record` swallows
 * and logs its own errors, because a note that saved but could not be
 * logged is still a note that saved.
 */
export class AuditLog {
  constructor(
    private readonly db: Database,
    private readonly publish: (projectId: string | null, userId: string | null, event: DomainEvent) => void,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async record(input: AuditInput): Promise<AuditEntry | null> {
    try {
      const row = await this.#write(input);
      const entry = await this.#hydrate(row);
      // A project's line to the project, an account's to the account.
      this.publish(entry.projectId, entry.userId, {
        type: "audit.recorded",
        projectId: entry.projectId,
        entry,
      });
      return entry;
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  async #write(input: AuditInput): Promise<typeof auditLog.$inferSelect> {
    const now = new Date();
    const details = input.details ?? {};
    const targetId = input.targetId ?? null;

    if (input.coalesce && input.userId) {
      const [last] = await this.db
        .select()
        .from(auditLog)
        .where(
          and(
            input.projectId ? eq(auditLog.projectId, input.projectId) : isNull(auditLog.projectId),
            eq(auditLog.userId, input.userId),
            eq(auditLog.action, input.action),
            eq(auditLog.targetType, input.targetType),
            targetId ? eq(auditLog.targetId, targetId) : isNull(auditLog.targetId),
            gt(auditLog.updatedAt, new Date(now.getTime() - COALESCE_WINDOW_MS)),
          ),
        )
        .orderBy(desc(auditLog.updatedAt))
        .limit(1);
      if (last && withinWindow(last.updatedAt, now)) {
        const [updated] = await this.db
          .update(auditLog)
          .set({
            summary: input.summary,
            details: mergeDetails(last.details, details),
            count: sql`${auditLog.count} + 1`,
            clientId: input.clientId,
            updatedAt: now,
          })
          .where(eq(auditLog.id, last.id))
          .returning();
        if (updated) return updated;
      }
    }

    const [inserted] = await this.db
      .insert(auditLog)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        clientId: input.clientId,
        action: input.action,
        targetType: input.targetType,
        targetId,
        summary: input.summary,
        details,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return inserted!;
  }

  /** Newest first. `before` is the id of the last entry already shown. */
  async list(
    projectId: string,
    options: { before?: number; limit?: number; action?: string; userId?: string } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.db
      .select({ row: auditLog, login: users.login, email: users.email })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(
        and(
          eq(auditLog.projectId, projectId),
          options.before ? lt(auditLog.id, options.before) : undefined,
          // A prefix, so `note` matches every kind of note change.
          options.action ? sql`${auditLog.action} like ${`${options.action}%`}` : undefined,
          options.userId ? eq(auditLog.userId, options.userId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit);
    return rows.map(({ row, login, email }) => toEntry(row, login ?? email ?? null));
  }

  /** The account's own changes -- settings, connections -- newest first. */
  async listForAccount(
    userId: string,
    options: { before?: number; limit?: number; action?: string } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.db
      .select({ row: auditLog, login: users.login, email: users.email })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(
        and(
          isNull(auditLog.projectId),
          eq(auditLog.userId, userId),
          options.before ? lt(auditLog.id, options.before) : undefined,
          options.action ? sql`${auditLog.action} like ${`${options.action}%`}` : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit);
    return rows.map(({ row, login, email }) => toEntry(row, login ?? email ?? null));
  }

  async #hydrate(row: typeof auditLog.$inferSelect): Promise<AuditEntry> {
    if (!row.userId) return toEntry(row, null);
    const [user] = await this.db
      .select({ login: users.login, email: users.email })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    return toEntry(row, user?.login ?? user?.email ?? null);
  }
}

function toEntry(row: typeof auditLog.$inferSelect, actor: string | null): AuditEntry {
  return {
    id: String(row.id),
    projectId: row.projectId,
    userId: row.userId,
    actor,
    clientId: row.clientId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    details: row.details,
    count: row.count,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Roughly how much a save changed, in characters: the length of what differs
 * between the two texts once their common start and end are set aside.
 */
export function textDelta(before: string, after: string): { charsAdded: number; charsRemoved: number } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < max - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return {
    charsAdded: after.length - start - end,
    charsRemoved: before.length - start - end,
  };
}
