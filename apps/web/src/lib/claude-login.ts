/**
 * Reading `claude auth login`'s terminal output, and cleaning what the user
 * pastes back into it.
 *
 * The sign-in dialog drives the CLI's own login flow through a PTY and never
 * shows the terminal unless asked. Everything it needs to know comes from
 * the text the CLI prints, so this is where that text is read:
 *
 * - the OAuth address, which the CLI prints twice: once as the target of an
 *   OSC 8 hyperlink (never wrapped, since it is an escape sequence and not
 *   text), and once as coloured visible text. The hyperlink target is read
 *   first. Without one, the visible text is read with any line breaks a
 *   terminal put in it joined back up.
 * - `Paste code here if prompted >`, the readline prompt: the CLI is ready
 *   for a code.
 * - what follows a submitted code: `Login successful.`, `Login failed: …`
 *   (the CLI then exits), or `Invalid code. …` (it keeps prompting).
 * - `[exited with N]`, which the server's terminal reactor prints when the
 *   process ends.
 *
 * None of it is logged. The address carries a PKCE challenge and a state,
 * and the code is a credential; both stay in memory.
 */

/** CSI, OSC (terminated by BEL or ST) and the lone two-byte escapes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** An OSC 8 hyperlink's target: `ESC ] 8 ; params ; URI (BEL | ST)`. */
// eslint-disable-next-line no-control-regex
const OSC8_TARGET = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g

/** Where the address starts: claude.com or claude.ai, any oauth/authorize path. */
const URL_START = /https:\/\/(?:[a-z0-9-]+\.)*claude\.(?:com|ai)\/[^\s]*?oauth\/authorize/i

/** Strips colour, cursor and hyperlink escapes, leaving the visible text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

function isAuthorizeUrl(candidate: string): boolean {
  const match = URL_START.exec(candidate)
  if (!match || match.index !== 0) return false
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" && /(^|\.)claude\.(com|ai)$/i.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * The OAuth address the CLI printed, or null before it has.
 *
 * The visible-text fallback joins a line onto the address only when the
 * whole next line is one unbroken run of URL characters, which is what a
 * hard-wrapped address looks like. The prompt that follows it has spaces in
 * it, so it is never mistaken for the address's tail.
 */
export function extractOAuthUrl(raw: string): string | null {
  for (const match of raw.matchAll(OSC8_TARGET)) {
    const target = match[1]!.trim()
    if (isAuthorizeUrl(target)) return target
  }

  // The last piece has no line ending yet: output arrives in chunks, and an
  // address read before its line is over may be cut short. It waits.
  const lines = stripAnsi(raw).split(/\r?\n|\r/)
  const complete = lines.length - 1
  for (let i = 0; i < complete; i++) {
    const line = lines[i]!
    const start = line.search(/https:\/\//i)
    if (start < 0) continue
    let url = line.slice(start).split(/\s/)[0]!
    // Only an address that ran to the end of its line can continue on the next.
    const runsToEnd = line.slice(start).trimEnd().length === url.length
    let cut = false
    for (let j = i + 1; runsToEnd && j < lines.length; j++) {
      const next = lines[j]!.trim()
      if (!next || !/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(next)) break
      if (j === complete) {
        cut = true
        break
      }
      url += next
    }
    if (!cut && isAuthorizeUrl(url)) return url
  }
  return null
}

/** The CLI is sitting at its readline prompt, waiting for a code. */
export function hasCodePrompt(raw: string): boolean {
  return /Paste code here/i.test(stripAnsi(raw))
}

/** The line the server's terminal reactor prints when the process ends. */
export function hasExited(raw: string): boolean {
  return /\[exited with /.test(raw)
}

export type LoginOutcome =
  | { kind: "success" }
  /** The code was refused and the CLI has given up: a new sign-in is needed. */
  | { kind: "failed"; message: string }
  /** The code was malformed; the CLI is still prompting for another. */
  | { kind: "invalid"; message: string }
  /** The CLI's own timeout, or a code it calls expired. */
  | { kind: "expired"; message: string }

/**
 * What the CLI said about a submitted code, reading only the output that
 * arrived after it was sent. Null while it has said nothing conclusive.
 */
export function detectOutcome(rawSinceSubmit: string): LoginOutcome | null {
  const text = stripAnsi(rawSinceSubmit)
  if (/Login successful/i.test(text)) return { kind: "success" }

  const failed = /Login failed:?\s*([^\r\n]*)/i.exec(text)
  if (failed) {
    const message = failed[1]!.trim() || "The code wasn't accepted."
    if (/timed out|expired/i.test(message) && !/may be/i.test(message)) {
      return { kind: "expired", message }
    }
    return { kind: "failed", message }
  }

  const invalid = /(Invalid code[^\r\n]*|That code is not from this sign-in[^\r\n]*)/i.exec(text)
  if (invalid) return { kind: "invalid", message: invalid[1]!.trim() }

  const timedOut = /([^\r\n]*\b(?:timed out|has expired)[^\r\n]*)/i.exec(text)
  if (timedOut) return { kind: "expired", message: timedOut[1]!.trim() }

  return null
}

/**
 * Whitespace and the invisible characters a copy from a web page or chat
 * app likes to bring along: zero-width spaces and joiners, word joiner,
 * byte-order mark, bidi marks and isolates, soft hyphen. `\s` already covers
 * NBSP, the other Unicode spaces and the line/paragraph separators.
 */
const INVISIBLE = /[\s­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

/**
 * A pasted authorization code or token, cleaned. Nothing else is touched:
 * the `#` and the state after it are part of the code the CLI wants.
 */
export function sanitizeSecret(text: string): string {
  return text.replace(INVISIBLE, "")
}

/**
 * A light check of an authorization code's shape: `code#state`, both halves
 * present. The CLI splits on `#` and refuses anything else, so a code
 * without one is not worth sending.
 */
export function checkAuthCode(code: string): { ok: boolean; hint: string | null } {
  if (!code) return { ok: false, hint: null }
  const hash = code.indexOf("#")
  if (hash < 0) return { ok: false, hint: "The code should contain a “#”: copy the whole thing." }
  if (hash === 0 || hash === code.length - 1) {
    return { ok: false, hint: "Part of the code is missing on one side of the “#”." }
  }
  return { ok: true, hint: null }
}

/** Setup tokens are `sk-ant-oat01-…`; this is a hint, not a gate. */
export function checkSetupToken(token: string): { ok: boolean; hint: string | null } {
  if (!token) return { ok: false, hint: null }
  if (!/^sk-ant-oat\d+-/.test(token)) {
    return { ok: true, hint: "This doesn't look like a setup token (they start with sk-ant-oat01-)." }
  }
  if (token.length < 40) return { ok: true, hint: "This looks too short to be a whole token." }
  return { ok: true, hint: null }
}
