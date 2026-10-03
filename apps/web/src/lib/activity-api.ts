/**
 * The activity log, over the API: a project's history of who changed what,
 * and the account's own (settings, connections, tokens).
 */

import type { AuditEntry } from "@ucch/protocol";

export interface ActivityQuery {
  /** The id of the oldest entry already shown, to page further back. */
  before?: string;
  /** A prefix: `note` matches every kind of note change. */
  action?: string;
  /** Only this person's changes. Project history only. */
  user?: string;
  limit?: number;
}

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

function search(query: ActivityQuery): string {
  const params = new URLSearchParams();
  if (query.before) params.set("before", query.before);
  if (query.action) params.set("action", query.action);
  if (query.user) params.set("user", query.user);
  if (query.limit) params.set("limit", String(query.limit));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function fetchProjectActivity(hash: string, query: ActivityQuery = {}): Promise<AuditEntry[]> {
  const response = await fetch(`/api/projects/${hash}/activity${search(query)}`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the activity.");
  return ((await response.json()) as { entries: AuditEntry[] }).entries;
}

export async function fetchAccountActivity(query: ActivityQuery = {}): Promise<AuditEntry[]> {
  const response = await fetch(`/api/activity${search({ ...query, user: undefined })}`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the activity.");
  return ((await response.json()) as { entries: AuditEntry[] }).entries;
}

/**
 * Puts a pushed entry where it belongs: an entry already shown is replaced
 * (repeated saves fold into one line and arrive again with a new count),
 * and either way the latest goes to the top.
 */
export function upsertEntry(entries: readonly AuditEntry[], entry: AuditEntry): AuditEntry[] {
  return [entry, ...entries.filter((e) => e.id !== entry.id)];
}

/** Whether an entry belongs under an action filter, the way the server matches it. */
export function matchesAction(entry: AuditEntry, action: string | undefined): boolean {
  return !action || entry.action.startsWith(action);
}
