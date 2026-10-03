import { NextResponse, type NextRequest } from "next/server";

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
const PUBLIC_SLUG = /^\/([a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?-[a-z0-9]{6})(\/.*)?$/;

export function middleware(request: NextRequest) {
  const match = PUBLIC_SLUG.exec(request.nextUrl.pathname);
  if (!match) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/shared/${match[1]}${match[2] ?? ""}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Only paths that could be a public address: one segment, then anything.
  // Static files and the API have their own prefixes and never match.
  matcher: ["/((?!api|_next|file-icons|favicon.ico|shared).*)"],
};
