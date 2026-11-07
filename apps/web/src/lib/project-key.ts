import { PROJECT_KEY_MIN } from "@ucch/protocol/plain"

/** Why a new project key cannot be used yet, or null when it can. */
export function newKeyProblem(key: string, confirm: string): string | null {
  if (key.length < PROJECT_KEY_MIN) return `Use at least ${PROJECT_KEY_MIN} characters.`
  if (key !== confirm) return "The two keys do not match."
  return null
}
