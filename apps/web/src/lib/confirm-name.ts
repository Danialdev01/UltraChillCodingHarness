/**
 * Whether what was typed matches the name being confirmed.
 *
 * Deleting a project deletes its whole event log, and the sidebar is a list
 * of names that often differ by one word -- three "laravel" rows sit in it
 * today. Typing the name is the guard against removing the wrong one, so the
 * comparison is exact: surrounding whitespace is forgiven, because a name
 * copied out of the dialog brings some with it, and nothing else is.
 */
export function confirmsName(typed: string, name: string): boolean {
  const cleaned = typed.trim();
  return cleaned.length > 0 && cleaned === name.trim();
}
