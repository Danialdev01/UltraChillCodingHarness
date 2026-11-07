import { expect, test, type Page } from "@playwright/test"

import { API, COOKIE, api } from "./omp-thread"

/**
 * Account Setting -> API keys: Reveal, Hide, Copy and the password step-up.
 *
 *   pnpm --filter @ucch/web e2e api-keys
 *
 * Uses the dev user's Resend key slot. A test key is stored through the
 * older `PUT /api/settings/resend`, which skips the live check, so nothing
 * calls Resend. A key already there is revealed by the first test (through
 * the dialog, as a person would), held in memory, and put back afterwards;
 * with none, the slot is emptied again. The dev user needs a password: one
 * is set when it has none; otherwise pass it as `E2E_PASSWORD`.
 *
 * The tests run in order and share one step-up: under DEV_AUTH_BYPASS every
 * request is the same session, so only the first sees the dialog for sure.
 */

const KEY = `re_e2eTestKey_${"x".repeat(20)}_d00d`
const MASKED = /^re_•+d00d$/

async function call(path: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { cookie: `ucch_session=${COOKIE}`, "content-type": "application/json", ...(init.headers ?? {}) },
  })
}

test.describe.configure({ mode: "serial" })

let password = process.env.E2E_PASSWORD ?? ""
/** The dev user's own Resend key, while the test one stands in for it. */
let original: string | null = null
let originalMeta: { prefix: string; last4: string } | null = null

const store = (apiKey: string | null) =>
  call("/api/settings/resend", { method: "PUT", body: JSON.stringify({ apiKey }) })

test.beforeAll(async () => {
  const profile = await api("/api/me")
  if (!profile.hasPassword) {
    password = "e2e-step-up-password"
    const set = await call("/api/account/password", { method: "PUT", body: JSON.stringify({ newPassword: password }) })
    expect(set.ok).toBe(true)
  }
  test.skip(!password, "the dev user has a password: pass it as E2E_PASSWORD")
  const resend = (await api("/api/account/keys")).keys.find((k: { provider: string }) => k.provider === "resend")
  if (resend.configured) originalMeta = { prefix: resend.prefix ?? "", last4: resend.last4 }
  else expect((await store(KEY)).ok).toBe(true)
})

test.afterAll(async () => {
  // Put back what was there, or nothing.
  if (original) await store(original)
  else await call("/api/account/keys/resend", { method: "DELETE" })
})

async function open(page: Page, baseURL: string, last4 = "d00d") {
  await page.context().addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL).hostname, path: "/" }])
  await page.goto("/setting/api")
  const field = page.getByRole("textbox", { name: new RegExp(`Resend key, hidden, ending ${last4}`) })
  await expect(field).toBeVisible({ timeout: 60_000 })
  return field
}

const resendCard = (page: Page) => page.getByRole("region", { name: "Resend" })

/** Through the dialog when it opens; straight through when the step-up is still fresh. */
async function stepUpIfAsked(page: Page) {
  const dialog = page.getByRole("dialog")
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel("Password").fill(password)
    await dialog.getByLabel("Password").press("Enter")
    await expect(dialog).toBeHidden()
  }
}

test("the step-up dialog: a wrong password stays, the right one reveals", async ({ page, baseURL }) => {
  const field = await open(page, baseURL!, originalMeta?.last4)
  const masked = originalMeta ? new RegExp(`^${originalMeta.prefix}•+${originalMeta.last4}$`) : MASKED
  await expect(field).toHaveText(masked)
  const card = resendCard(page)
  const revealButton = card.getByRole("button", { name: "Reveal" })
  await revealButton.click()

  const dialog = page.getByRole("dialog", { name: "Reveal Resend key" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Password")).toBeFocused()
  await dialog.getByLabel("Password").fill("not the password")
  await dialog.getByLabel("Password").press("Enter")
  await expect(dialog.getByRole("alert")).toHaveText("That password isn't right.")
  await expect(dialog).toBeVisible()

  await dialog.getByLabel("Password").fill(password)
  await dialog.getByRole("button", { name: "Reveal key" }).click()
  await expect(dialog).toBeHidden()
  const revealed = page.getByRole("textbox", { name: /Resend key, revealed/ })
  await expect(revealed).toHaveValue(/^re_[^•]+$/)
  await expect(revealed).toHaveValue(originalMeta ? new RegExp(`${originalMeta.last4}$`) : KEY)
  if (originalMeta) original = await revealed.inputValue()
  await expect(card.getByRole("timer")).toHaveText(/Hides in \d+s/)
  await expect(card.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true")
  // Focus went back to the button that opened the dialog, now named Hide.
  await expect(card.getByRole("button", { name: "Hide" })).toBeFocused()

  // Hide: masked again.
  await card.getByRole("button", { name: "Hide" }).click()
  await expect(page.getByRole("textbox", { name: /Resend key, hidden/ })).toHaveText(masked)

  // Inside the five minutes, no dialog.
  await card.getByRole("button", { name: "Reveal" }).click()
  await expect(page.getByRole("textbox", { name: /Resend key, revealed/ })).toHaveValue(/^re_[^•]+$/)
  await expect(page.getByRole("dialog")).toBeHidden()

  // The rest run on the test key.
  if (originalMeta) expect((await store(KEY)).ok).toBe(true)
})

test("a revealed key hides itself when the countdown ends", async ({ page, baseURL }) => {
  await page.clock.install()
  await open(page, baseURL!)
  const card = resendCard(page)
  await card.getByRole("button", { name: "Reveal" }).click()
  await stepUpIfAsked(page)
  await expect(page.getByRole("textbox", { name: /Resend key, revealed/ })).toHaveValue(KEY)
  await page.clock.fastForward(31_000)
  await expect(page.getByRole("textbox", { name: /Resend key, hidden/ })).toHaveText(MASKED)
  await expect(card.getByRole("timer")).toHaveCount(0)
})

test("a revealed key hides itself when the tab is hidden", async ({ page, baseURL }) => {
  await open(page, baseURL!)
  const card = resendCard(page)
  await card.getByRole("button", { name: "Reveal" }).click()
  await stepUpIfAsked(page)
  await expect(page.getByRole("textbox", { name: /Resend key, revealed/ })).toHaveValue(KEY)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(page.getByRole("textbox", { name: /Resend key, hidden/ })).toHaveText(MASKED)
})

test("Copy puts the key on the clipboard without ever showing it", async ({ page, baseURL, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL!).origin })
  const field = await open(page, baseURL!)
  // Watch every frame for the key anywhere on the page: text or field value.
  await page.evaluate((key) => {
    const w = window as unknown as { __keySeen: boolean }
    w.__keySeen = false
    const look = () => {
      const values = [...document.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value)
      if (document.body.innerText.includes(key) || values.some((v) => v.includes(key))) w.__keySeen = true
      requestAnimationFrame(look)
    }
    look()
  }, KEY)

  const card = resendCard(page)
  await card.getByRole("button", { name: "Copy" }).click()
  const dialog = page.getByRole("dialog", { name: "Copy Resend key" })
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel("Password").fill(password)
    await dialog.getByRole("button", { name: "Copy key" }).click()
  }
  await expect(card.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(KEY)
  await expect(page.getByRole("textbox", { name: /Resend key, hidden/ })).toHaveText(MASKED)
  await expect(card.getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 5_000 })
  expect(await page.evaluate(() => (window as unknown as { __keySeen: boolean }).__keySeen)).toBe(false)
})
