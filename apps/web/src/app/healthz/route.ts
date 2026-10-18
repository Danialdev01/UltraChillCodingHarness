/**
 * Liveness for Docker and Traefik.
 *
 * These used to probe `/login`, which is a full server render -- the root
 * layout reads cookies, so it can never be static -- every ten seconds, per
 * replica, from both. Answering at all is the signal: if this process can
 * serve a route, it can serve the app.
 */
export const dynamic = "force-static"

export function GET(): Response {
  return Response.json({ status: "ok" })
}
