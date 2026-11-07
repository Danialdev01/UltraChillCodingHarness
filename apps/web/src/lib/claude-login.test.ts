import { describe, expect, it } from "vitest"

import {
  checkAuthCode,
  checkSetupToken,
  detectOutcome,
  extractOAuthUrl,
  hasCodePrompt,
  hasExited,
  sanitizeSecret,
  stripAnsi,
} from "./claude-login"

const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=oez5y9Bf5CPLWW_PLOvUkT0MnJi-GpGC8SFK5PajhMQ&code_challenge_method=S256&state=eb-rH9PfdfWgb49LiK_TSF4IAMBtZz2-d5s27u5EeBI"

/** What `claude auth login` 2.1.x prints in a PTY, escapes and all. */
const CLI_OUTPUT =
  "Opening browser to sign in…\r\n" +
  `If the browser didn't open, visit: \x1b]8;;${URL}\x07\x1b[94m${URL}\x1b[39m\x1b]8;;\x07\r\n` +
  "Paste code here if prompted > "

describe("extractOAuthUrl", () => {
  it("reads the OSC 8 hyperlink target", () => {
    expect(extractOAuthUrl(CLI_OUTPUT)).toBe(URL)
  })

  it("is null before the address has arrived", () => {
    expect(extractOAuthUrl("Opening browser to sign in…\r\n")).toBeNull()
    // Half of the hyperlink: its terminator has not arrived yet.
    expect(extractOAuthUrl(`visit: \x1b]8;;${URL.slice(0, 60)}`)).toBeNull()
  })

  it("joins a hard-wrapped address back up, and stops at the prompt", () => {
    const wrapped = [URL.slice(0, 100), URL.slice(100, 200), URL.slice(200)].join("\r\n")
    const text = `If the browser didn't open, visit: \x1b[94m${wrapped}\x1b[39m\r\nPaste code here if prompted > `
    expect(extractOAuthUrl(text)).toBe(URL)
  })

  it("accepts claude.ai and ignores other hosts", () => {
    const ai = URL.replace("https://claude.com/cai/", "https://claude.ai/")
    expect(extractOAuthUrl(`visit: ${ai}\r\n`)).toBe(ai)
    expect(extractOAuthUrl("visit: https://evil.example/oauth/authorize?x=1\r\n")).toBeNull()
    expect(extractOAuthUrl("visit: https://claude.com.evil.example/oauth/authorize\r\n")).toBeNull()
  })
})

describe("prompt and exit", () => {
  it("sees the code prompt", () => {
    expect(hasCodePrompt(CLI_OUTPUT)).toBe(true)
    expect(hasCodePrompt("Opening browser to sign in…")).toBe(false)
  })

  it("sees the reactor's exit line", () => {
    expect(hasExited("\r\n[exited with 1]\r\n")).toBe(true)
    expect(hasExited(CLI_OUTPUT)).toBe(false)
  })
})

describe("detectOutcome", () => {
  it("reads success", () => {
    expect(detectOutcome("abc#def\r\nLogin successful.\r\n")).toEqual({ kind: "success" })
  })

  it("reads a refused code, which ends the CLI", () => {
    const out =
      "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\r\n\x1b[?25h"
    expect(detectOutcome(out)).toEqual({
      kind: "failed",
      message: expect.stringMatching(/^That code wasn't accepted\./),
    })
  })

  it("reads a malformed code, after which the CLI keeps prompting", () => {
    expect(detectOutcome("Invalid code. Please make sure the full code was copied.\r\n")).toEqual({
      kind: "invalid",
      message: "Invalid code. Please make sure the full code was copied.",
    })
  })

  it("reads the CLI's own timeout", () => {
    expect(detectOutcome("Login failed: The sign-in timed out.\r\n")?.kind).toBe("expired")
  })

  it("is null while nothing conclusive has been printed", () => {
    expect(detectOutcome("abc#def\r\n")).toBeNull()
    expect(stripAnsi("\x1b[94mhi\x1b[39m")).toBe("hi")
  })
})

describe("sanitizeSecret", () => {
  it("strips whitespace and invisible characters, keeping the #state", () => {
    const pasted = "  ​abC-12_x yz\r\n#st‍ate﻿⁠ \n"
    expect(sanitizeSecret(pasted)).toBe("abC-12_xyz#state")
  })
})

describe("format checks", () => {
  it("wants code#state", () => {
    expect(checkAuthCode("").ok).toBe(false)
    expect(checkAuthCode("abcdef").ok).toBe(false)
    expect(checkAuthCode("#abc").ok).toBe(false)
    expect(checkAuthCode("abc#").ok).toBe(false)
    expect(checkAuthCode("abc#def")).toEqual({ ok: true, hint: null })
  })

  it("hints at, but does not refuse, an odd setup token", () => {
    expect(checkSetupToken("hello")).toEqual({ ok: true, hint: expect.any(String) })
    expect(checkSetupToken(`sk-ant-oat01-${"x".repeat(60)}`)).toEqual({ ok: true, hint: null })
  })
})
