import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Refreshes the Supabase session on every request and bounces signed-out
 * visitors to the login page.
 *
 * This is a convenience, not the security boundary. Next's own guidance is to
 * keep real authorization in the pages and actions themselves, so every route
 * that reads tenant data calls requireMembership() regardless of what happens
 * here.
 */
// Two routes are reachable signed out, and both authenticate themselves:
// Shopify signs its webhooks and the receiver checks the HMAC before reading
// anything, and the job runner takes a shared secret because Vercel Cron has
// no session to offer.
const PUBLIC_PATHS = [
  "/login",
  "/auth",
  "/api/health",
  "/api/jobs",
  "/api/shopify/webhooks",
  "/status",
];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const loginUrl = new URL("/login", request.url);
    // Sending someone back to an API route after signing in would replay a
    // request without the query string that made it meaningful, so only
    // pages are remembered.
    if (pathname !== "/" && !pathname.startsWith("/api/")) {
      loginUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  // Everything except Next's own assets and static files, so that cookie
  // refresh does not run on images and scripts.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
