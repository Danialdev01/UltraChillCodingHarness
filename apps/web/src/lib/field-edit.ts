/**
 * Field-at-a-time writes for the Tasks board and the timeline.
 *
 * Two people on one board change different things at once: one drags a
 * card while the other renames it. So a write sends only the fields that
 * changed, each with the value it started from (`base`); the server refuses
 * only when somebody else changed one of *those* fields since. Every other
 * tab gets the saved row in the event and puts it in place (`upsertRow`),
 * so a refetch of the whole list never lands on top of an edit in flight.
 */

/** Same value, for the field types these rows hold: strings, numbers, null, arrays of plain objects. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** What `next` changes about `start`, and what those fields held before. */
export function fieldChanges<T extends object>(start: T, next: Partial<T>): { patch: Partial<T>; base: Partial<T> } {
  const patch: Partial<T> = {}
  const base: Partial<T> = {}
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] === undefined || same(start[key], next[key])) continue
    patch[key] = next[key]
    base[key] = start[key]
  }
  return { patch, base }
}

/** A 409 from a field-level write: `current` is the row as the other person saved it. */
export class FieldConflictError<T> extends Error {
  constructor(
    message: string,
    readonly current: T,
  ) {
    super(message)
    this.name = "FieldConflictError"
  }
}

interface Row {
  id: string
  updatedAt: string
}

/**
 * Puts a row saved elsewhere into a cached list, where that list holds it,
 * unless the copy there is already newer. Anything that is not a list of
 * rows (a settings object under the same key family) is left alone.
 */
export function upsertRow(row: Row) {
  return (data: unknown): unknown => {
    if (!Array.isArray(data)) return data
    const index = data.findIndex((r: Row) => r?.id === row.id)
    if (index === -1 || (data[index] as Row).updatedAt > row.updatedAt) return data
    const next = data.slice()
    next[index] = row
    return next
  }
}

/** Takes a deleted row out of a cached list. */
export function removeRow(id: string) {
  return (data: unknown): unknown =>
    Array.isArray(data) && data.some((r: Row) => r?.id === id) ? data.filter((r: Row) => r?.id !== id) : data
}
