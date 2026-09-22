/**
 * Shopify app configuration. The credentials are read lazily so that the app
 * still builds and runs with Shopify unconfigured — every other page works,
 * and the channels page says so rather than crashing.
 */

/** Admin API version this app pins. Shopify keeps each version for a year. */
export const SHOPIFY_API_VERSION = "2025-07";

/**
 * Requested at install. read_orders and read_customers are what a ticket is
 * built from; fulfillments and returns are what "where is my order" and
 * "I want to send this back" resolve against.
 */
export const SHOPIFY_SCOPES = [
  "read_orders",
  "read_customers",
  "read_fulfillments",
  "read_returns",
].join(",");

/** The webhook topics registered on every store at connect time. */
export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/cancelled",
  "refunds/create",
  "app/uninstalled",
] as const;

export type ShopifyCredentials = { apiKey: string; apiSecret: string };

/** Null rather than a throw: callers decide whether unconfigured is fatal. */
export function shopifyCredentials(): ShopifyCredentials | null {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

export function isShopifyConfigured(): boolean {
  return shopifyCredentials() !== null;
}

/**
 * Shop domains arrive from user input and from Shopify headers, and both end
 * up in a URL we fetch. Anything that is not a myshopify.com subdomain is
 * rejected here so neither can be turned into a request somewhere else.
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (value && !value.includes(".")) {
    value = `${value}.myshopify.com`;
  }
  return SHOP_DOMAIN.test(value) ? value : null;
}

/**
 * The origin Shopify redirects back to. It has to match the app's allowed
 * redirection URL exactly, so an explicit value wins over whatever host the
 * request happens to carry.
 */
export function appOrigin(
  headers: Headers,
  fallbackOrigin?: string,
): string {
  const configured = process.env.SHOPIFY_APP_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  if (forwardedHost) {
    const proto = headers.get("x-forwarded-proto") ?? "https";
    return `${proto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`;
  }

  return fallbackOrigin ?? "";
}

export function callbackUrl(headers: Headers, fallbackOrigin?: string): string {
  return `${appOrigin(headers, fallbackOrigin)}/api/shopify/callback`;
}

export function webhookUrl(headers: Headers, fallbackOrigin?: string): string {
  return `${appOrigin(headers, fallbackOrigin)}/api/shopify/webhooks`;
}
