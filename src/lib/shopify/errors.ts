/**
 * Why a connection attempt stopped.
 *
 * The routes redirect back to /channels with one of these codes rather than a
 * message, so that the page never renders text that came in on a query
 * string. Anything with a detail worth keeping is logged server side instead.
 */
export const CONNECT_ERRORS = {
  not_admin: "Only an owner or admin can connect a store.",
  not_configured:
    "Shopify is not set up on this deployment yet. It needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET.",
  bad_shop:
    "That does not look like a Shopify store. Use the myshopify.com address, like acme-supplies.myshopify.com.",
  expired: "That install link has expired. Start the connection again.",
  shop_mismatch:
    "Shopify came back about a different store than the one you started with.",
  bad_signature: "Shopify's signature on that response did not check out.",
  no_code: "Shopify did not return an authorization code.",
  exchange_failed:
    "Shopify would not issue an access token. Check the app's credentials and try again.",
  save_failed: "The store was authorized but could not be saved. Try again.",
} as const;

export type ConnectErrorCode = keyof typeof CONNECT_ERRORS;

export function connectErrorMessage(code: string | undefined): string | null {
  return code && code in CONNECT_ERRORS
    ? CONNECT_ERRORS[code as ConnectErrorCode]
    : null;
}
