/**
 * The API keys page's view of the account's stored keys, and its calls.
 *
 * Nothing here is cached: every call is `no-store`, and none goes through the
 * persisted query cache. A revealed key lives in one component's state for
 * at most thirty seconds and is never written anywhere else -- not storage,
 * not a URL, not the console.
 */

export type ApiKeyProvider = "openrouter" | "resend" | "github"

export interface ApiKeyMeta {
  provider: ApiKeyProvider
  configured: boolean
  prefix: string | null
  last4: string | null
  scopes: string | null
  createdAt: string | null
  updatedAt: string | null
  lastUsedAt: string | null
  lastRevealedAt: string | null
}

export interface ApiKeysResponse {
  keys: ApiKeyMeta[]
  encryptionAvailable: boolean
  /** Whether Reveal can work at all for this account, and if not why. */
  reveal: { available: true } | { available: false; code: string; reason: string }
  stepUpExpiresInSeconds: number
  /** A GitHub sign-in token exists, which the repository list falls back to. */
  githubFromLogin: boolean
}

/** What a masked key looks like: its prefix, a run of dots, its last four. */
export const MASK = "••••••••••••••••••••••••"

export function maskKey(meta: Pick<ApiKeyMeta, "prefix" | "last4">): string {
  return `${meta.prefix ?? ""}${MASK}${meta.last4 ?? ""}`
}

/**
 * "Just now", "2 minutes ago", "Yesterday", "3 weeks ago". `now` is a
 * parameter so tests and a whole card can share one instant.
 */
export function relativeWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "Never"
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return "Never"
  const seconds = Math.round((then - now) / 1000)
  if (Math.abs(seconds) < 45) return "Just now"
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  for (const [unit, size] of [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    if (Math.abs(seconds) >= size) {
      const text = format.format(Math.round(seconds / size), unit)
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
  return "Just now"
}

/** The full date and time, for a `title`. */
export function fullDate(iso: string | null): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })
}

const NO_STORE: RequestInit = { credentials: "include", cache: "no-store" }

async function errorOf(response: Response): Promise<{ error: string; code?: string; retryAfterSeconds?: number }> {
  try {
    const body = (await response.json()) as { error?: string; code?: string; retryAfterSeconds?: number }
    return { error: body.error ?? `Request failed (${response.status}).`, code: body.code, retryAfterSeconds: body.retryAfterSeconds }
  } catch {
    return { error: `Request failed (${response.status}).` }
  }
}

export async function fetchApiKeys(): Promise<ApiKeysResponse> {
  const response = await fetch("/api/account/keys", NO_STORE)
  if (!response.ok) throw new Error((await errorOf(response)).error)
  return (await response.json()) as ApiKeysResponse
}

export async function saveApiKey(provider: ApiKeyProvider, key: string): Promise<ApiKeyMeta> {
  const response = await fetch(`/api/account/keys/${provider}`, {
    ...NO_STORE,
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  })
  if (!response.ok) throw new Error((await errorOf(response)).error)
  return ((await response.json()) as { key: ApiKeyMeta }).key
}

export async function removeApiKey(provider: ApiKeyProvider): Promise<void> {
  const response = await fetch(`/api/account/keys/${provider}`, { ...NO_STORE, method: "DELETE" })
  if (!response.ok) throw new Error((await errorOf(response)).error)
}

export type ReauthResult = { ok: true } | { ok: false; error: string; status: number }

export async function reauthenticate(password: string): Promise<ReauthResult> {
  const response = await fetch("/api/account/reauth", {
    ...NO_STORE,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (response.ok) return { ok: true }
  const { error, retryAfterSeconds } = await errorOf(response)
  if (response.status === 429) {
    const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60))
    return { ok: false, status: 429, error: `Too many attempts, try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }
  }
  return { ok: false, status: response.status, error }
}

export type RevealResult =
  | { kind: "key"; key: string; expiresInSeconds: number }
  | { kind: "reauth" }
  | { kind: "error"; error: string; code?: string }

/** The one call that returns a key. POST, so it is never prefetched, cached or kept in history. */
export async function revealApiKey(provider: ApiKeyProvider, purpose: "reveal" | "copy"): Promise<RevealResult> {
  const response = await fetch(`/api/account/keys/${provider}/reveal`, {
    ...NO_STORE,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose }),
  })
  if (response.ok) {
    const body = (await response.json()) as { key: string; expiresInSeconds: number }
    return { kind: "key", key: body.key, expiresInSeconds: body.expiresInSeconds }
  }
  const failure = await errorOf(response)
  if (response.status === 403 && failure.code === "REAUTH_REQUIRED") return { kind: "reauth" }
  return { kind: "error", error: failure.error, code: failure.code }
}

/** Whether this browser can put text on the clipboard at all. */
export function clipboardAvailable(): boolean {
  return Boolean(globalThis.navigator?.clipboard?.writeText) && globalThis.isSecureContext !== false
}

/**
 * Writes text that is still on its way to the clipboard.
 *
 * Safari only allows a clipboard write during the click that asked for it,
 * and the key arrives a network round trip later. A `ClipboardItem` built
 * from the promise is written now and filled in when it resolves, which every
 * current browser accepts; `writeText` after the wait is the fallback.
 */
export async function writeClipboardLater(text: Promise<string | null>): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard) return false
  if (typeof ClipboardItem !== "undefined" && clipboard.write) {
    try {
      const blob = text.then((value) => {
        if (value === null) throw new Error("nothing to copy")
        return new Blob([value], { type: "text/plain" })
      })
      await clipboard.write([new ClipboardItem({ "text/plain": blob })])
      return true
    } catch {
      // The key never came (refused, or the dialog was cancelled), or this
      // browser wants a plain string: try that, if there is one.
      const value = await text.catch(() => null)
      if (value === null) return false
      try {
        await clipboard.writeText(value)
        return true
      } catch {
        return false
      }
    }
  }
  const value = await text.catch(() => null)
  if (value === null) return false
  try {
    await clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}
