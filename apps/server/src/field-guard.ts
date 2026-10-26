import { isDeepStrictEqual } from "node:util";

/**
 * The fields a write expected to find as they were and did not.
 *
 * A board or a chart is edited a field at a time, often by two people at
 * once: one drags a bar while the other renames it. A whole-row version
 * (`ifUpdatedAt`) calls that a conflict, though neither touched what the
 * other changed. Instead the client sends, for each field it is changing,
 * the value it started from (`base`); the write goes ahead unless one of
 * those fields has since been changed by somebody else.
 */
export function staleFields(current: object, base: Record<string, unknown> | undefined): string[] {
  if (!base) return [];
  const row = current as Record<string, unknown>;
  return Object.entries(base)
    .filter(([key, value]) => value !== undefined && !isDeepStrictEqual(row[key], value))
    .map(([key]) => key);
}
