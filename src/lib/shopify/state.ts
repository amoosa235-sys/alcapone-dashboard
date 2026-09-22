/**
 * The OAuth state cookie. Written when the install starts and read once in
 * the callback, so it is scoped to the Shopify routes and short lived.
 *
 * SameSite has to be lax rather than strict: the callback is a top-level GET
 * navigation from shopify.com, and strict would withhold the cookie.
 */
export const OAUTH_STATE_COOKIE = "shopify_oauth_state";

export function oauthStateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api/shopify",
    maxAge: 600,
  };
}

/** Splits `${nonce}:${shop}` back apart, or null if the cookie is malformed. */
export function readOAuthState(
  value: string | undefined,
): { nonce: string; shop: string } | null {
  if (!value) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator < 1) {
    return null;
  }
  return {
    nonce: value.slice(0, separator),
    shop: value.slice(separator + 1),
  };
}
