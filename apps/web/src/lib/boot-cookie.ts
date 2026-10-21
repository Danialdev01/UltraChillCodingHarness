/**
 * Whether this browser session has been through the boot screen.
 *
 * Absent, the app layout covers the first page with the boot screen while the
 * whole app loads behind it (`components/boot-gate.tsx`). Once that is done --
 * or once the sign-in boot screen has done it -- this cookie is set, and later
 * reloads load the same things quietly instead. It has no expiry, so it ends
 * with the browser session; signing out removes it.
 *
 * A cookie rather than session storage because the server has to know: the
 * overlay is drawn in the first bytes of the page, before any script runs.
 */
export const WARM_COOKIE = "ucch_warm"

export function markWarm(): void {
  document.cookie = `${WARM_COOKIE}=1; path=/; SameSite=Lax`
}

export function forgetWarm(): void {
  document.cookie = `${WARM_COOKIE}=; path=/; SameSite=Lax; max-age=0`
}
