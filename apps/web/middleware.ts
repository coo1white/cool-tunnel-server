// SPDX-License-Identifier: AGPL-3.0-only

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const apiOrigin = process.env.CT_API_INTERNAL_ORIGIN ?? "http://127.0.0.1:9000";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    (path === "/login" || path === "/setup") &&
    request.nextUrl.search &&
    !(path === "/setup" && request.nextUrl.searchParams.has("token"))
  ) {
    const clean = request.nextUrl.clone();
    clean.search = "";
    return noStore(NextResponse.redirect(clean, 303));
  }
  if (path === "/login" || path === "/setup") {
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
  matcher: ["/login", "/setup"],
};
