/**
 * This browser tab's id, for telling its own changes apart from everyone
 * else's.
 *
 * Minted once per page load and held in memory rather than sessionStorage:
 * a duplicated tab copies sessionStorage, and two tabs with one id would each
 * take the other's edits for its own echo.
 */
export const TAB_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

let installed = false;

/**
 * Stamps every same-origin API request with this tab's id.
 *
 * Wrapping `fetch` once rather than threading a header through every call
 * site: the server reads it to say which window a change came from, and a
 * call that forgot it would show up as "unknown" in the activity log rather
 * than fail, so the coverage has to come from somewhere other than care.
 */
export function installTabHeader(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sameOrigin = url.startsWith("/") || url.startsWith(window.location.origin);
    if (!sameOrigin || !new URL(url, window.location.origin).pathname.startsWith("/api/")) {
      return original(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-ucch-client")) headers.set("x-ucch-client", TAB_ID);
    return original(input, { ...init, headers });
  };
}
