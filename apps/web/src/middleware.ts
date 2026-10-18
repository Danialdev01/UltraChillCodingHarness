import { NextResponse, type NextRequest } from "next/server";

import { needsSession, SESSION_COOKIE } from "@/lib/auth-gate";
import { WORKSPACE_HASH_COOKIE_NAME } from "@/lib/workspace-cookie";
import { WORKSPACE_HEADER } from "@/lib/workspace-header";

/**
 * A project's public site lives at `/{name}-{6 chars}/…`, which is the
 * address an owner shares. Its pages are built under `/shared/[slug]` --
 * outside the `(app)` group, so no session is asked for -- and this maps one
 * onto the other without changing what the visitor sees in the bar.
 *
 * A rewrite rather than a second dynamic segment at the root: Next allows one
 * slug name per position, and `[projectHash]` already holds it. The shape is
 * strict enough (a trailing `-xxxxxx`) that no section, project hash or
 * `/api` path can match it by accident.
 */
const PUBLIC_SLUG = /^\/([a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?-[a-z0-9]{6}(?:[a-z0-9]{6})?)(\/.*)?$/;

/** The workspace a signed-in page is in, `/{ws}/…`. */
const WORKSPACE_PATH = /^\/([a-z0-9]{12})(?:\/|$)/;

/**
 * A workspace's pages as they were addressed before workspaces had
 * addresses of their own: at the root, for whichever workspace a cookie
 * named. Old links and bookmarks are sent on to the last workspace open,
 * or to the workspace list when there is none to go to.
 */
const ROOT_SECTION = /^\/(?:dashboard|code|database|publish|todo|workspace-settings)(?:\/.*)?$/;

export function middleware(request: NextRequest) {
  const match = PUBLIC_SLUG.exec(request.nextUrl.pathname);
  if (match) {
    const url = request.nextUrl.clone();
    url.pathname = `/shared/${match[1]}${match[2] ?? ""}`;
    return NextResponse.rewrite(url);
  }

  if (ROOT_SECTION.test(request.nextUrl.pathname)) {
    const ws = request.cookies.get(WORKSPACE_HASH_COOKIE_NAME)?.value;
    const url = request.nextUrl.clone();
    const rest = url.pathname.startsWith("/dashboard") ? url.pathname.slice("/dashboard".length) : url.pathname;
    url.pathname = ws && /^[a-z0-9]{12}$/.test(ws) ? `/${ws}${rest}` : "/";
    return NextResponse.redirect(url);
  }

  // No session cookie at all: straight to sign-in, and back here after,
  // without rendering a shell that could only redirect.
  if (needsSession(request.nextUrl.pathname) && !request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    url.pathname = "/login";
    url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(url);
  }

  // Overwritten on every request, so a client cannot supply one of its own.
  const headers = new Headers(request.headers);
  headers.delete(WORKSPACE_HEADER);
  const ws = WORKSPACE_PATH.exec(request.nextUrl.pathname)?.[1];
  if (ws) headers.set(WORKSPACE_HEADER, ws);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Only paths that could be a public address: one segment, then anything.
  // Static files and the API have their own prefixes and never match.
  matcher: ["/((?!api|_next|file-icons|favicon.ico|shared).*)"],
};
