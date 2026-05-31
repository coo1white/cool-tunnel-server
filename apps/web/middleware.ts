// SPDX-License-Identifier: AGPL-3.0-only

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";

// Pre-session pages rendered by admin-api (Bun/Hono) so cookie state
// stays in one place. /two-factor added in v0.7.3 for the better-auth
// twoFactor plugin's login second step — see Learning:-14-better-auth.
const PRE_SESSION_PAGES = new Set(["/login", "/setup", "/two-factor"]);

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // Strip query strings on the pre-session pages — they're rendered by
  // admin-api and we don't want stale tokens/state to bleed in via URL.
  // /setup is the one exception: it accepts a one-time bootstrap token.
  if (
    PRE_SESSION_PAGES.has(path) &&
    request.nextUrl.search &&
    !(path === "/setup" && request.nextUrl.searchParams.has("token"))
  ) {
    const clean = request.nextUrl.clone();
    clean.search = "";
    return noStore(NextResponse.redirect(clean, 303));
  }
  if (PRE_SESSION_PAGES.has(path)) {
    const upstream = new URL(path, apiOrigin);
    upstream.search = request.nextUrl.search;
    return NextResponse.rewrite(upstream);
  }
  return NextResponse.next();
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/login", "/setup", "/two-factor"],
};
