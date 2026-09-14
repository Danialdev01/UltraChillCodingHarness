/**
 * The signed-in account, over the API.
 *
 * Every call edits the caller's own row; there is no user id in any of these
 * signatures, because the server takes it from the session and never from
 * the request. That is the whole authorization story for this page.
 */

export interface Account {
  userId: string;
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** False for an account that only signs in through GitHub. */
  hasPassword: boolean;
}

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

export async function fetchAccount(): Promise<Account> {
  const response = await fetch("/api/me", { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load your account.");
  return (await response.json()) as Account;
}

/** The display name. An empty string clears it. Returns what was stored. */
export async function updateName(name: string): Promise<string | null> {
  const response = await fetch("/api/account/name", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) await fail(response, "Could not change your username.");
  return ((await response.json()) as { name: string | null }).name;
}

export async function updateEmail(email: string, currentPassword: string | null): Promise<string> {
  const response = await fetch("/api/account/email", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, ...(currentPassword ? { currentPassword } : {}) }),
  });
  if (!response.ok) await fail(response, "Could not change your email.");
  return ((await response.json()) as { email: string }).email;
}

export async function updatePassword(
  currentPassword: string | null,
  newPassword: string,
): Promise<void> {
  const response = await fetch("/api/account/password", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newPassword, ...(currentPassword ? { currentPassword } : {}) }),
  });
  if (!response.ok) await fail(response, "Could not change your password.");
}

/** `null` removes the picture. */
export async function updateAvatar(image: string | null): Promise<void> {
  const response = await fetch("/api/account/avatar", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image }),
  });
  if (!response.ok) await fail(response, "Could not save your picture.");
}
