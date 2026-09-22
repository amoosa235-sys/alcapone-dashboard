import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getMembership, getUser } from "@/lib/auth";
import {
  SHOPIFY_SCOPES,
  callbackUrl,
  normalizeShopDomain,
  shopifyCredentials,
} from "@/lib/shopify/config";
import type { ConnectErrorCode } from "@/lib/shopify/errors";
import { OAUTH_STATE_COOKIE, oauthStateCookieOptions } from "@/lib/shopify/state";

/**
 * Starts the Shopify install. The merchant lands here from the channels page,
 * and leaves on a redirect to Shopify's own permission screen.
 *
 * Nothing is written to the database yet: the shop is not connected until
 * Shopify redirects back to /api/shopify/callback with a code we can verify.
 */
export async function GET(request: NextRequest) {
  const back = new URL("/channels", request.url);

  function fail(code: ConnectErrorCode) {
    back.searchParams.set("error", code);
    return NextResponse.redirect(back);
  }

  const user = await getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/channels", request.url));
  }

  const membership = await getMembership();
  if (!membership) {
    return NextResponse.redirect(new URL("/pending", request.url));
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    return fail("not_admin");
  }

  const credentials = shopifyCredentials();
  if (!credentials) {
    return fail("not_configured");
  }

  const shop = normalizeShopDomain(request.nextUrl.searchParams.get("shop") ?? "");
  if (!shop) {
    return fail("bad_shop");
  }

  // The nonce goes to Shopify as `state` and into an httpOnly cookie. The
  // callback only proceeds when the two match, which is what stops someone
  // else's authorization code being planted on this account.
  const nonce = randomBytes(32).toString("hex");

  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", credentials.apiKey);
  authorize.searchParams.set("scope", SHOPIFY_SCOPES);
  authorize.searchParams.set(
    "redirect_uri",
    callbackUrl(request.headers, request.nextUrl.origin),
  );
  authorize.searchParams.set("state", nonce);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(
    OAUTH_STATE_COOKIE,
    `${nonce}:${shop}`,
    oauthStateCookieOptions(),
  );
  return response;
}
