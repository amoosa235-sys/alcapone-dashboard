import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The two signatures Shopify sends, both HMAC-SHA256 with the app's client
 * secret but over different things and in different encodings.
 */

function safeEqual(a: string, b: string, encoding: BufferEncoding): boolean {
  const left = Buffer.from(a, encoding);
  const right = Buffer.from(b, encoding);
  // timingSafeEqual throws on a length mismatch, which would leak length by
  // turning into a different error path, so check it first.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * OAuth callback: HMAC over the query string with the hmac parameter removed
 * and the rest sorted by key, hex encoded.
 *
 * https://shopify.dev/docs/apps/auth/oauth/getting-started
 *
 * Two canonical forms are accepted. Shopify's own Node library rebuilds the
 * string from decoded values and re-encodes them, while its other libraries
 * keep the query string exactly as it arrived; the two differ as soon as a
 * value contains a character like the `/` or `=` in `host`. Accepting either
 * gives up nothing, because forging a digest for either form still needs the
 * client secret, and it means an install cannot fail on a canonicalization
 * detail.
 */
export function verifyOAuthCallback(
  params: URLSearchParams,
  rawSearch: string,
  apiSecret: string,
): boolean {
  const provided = params.get("hmac");
  if (!provided) {
    return false;
  }

  const signed = ([key]: readonly [string, string]) =>
    key !== "hmac" && key !== "signature";
  const byKey = (a: readonly [string, string], b: readonly [string, string]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

  const reEncoded = new URLSearchParams(
    [...params.entries()].filter(signed).sort(byKey),
  ).toString();

  const asReceived = rawSearch
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map((pair): readonly [string, string] => {
      const at = pair.indexOf("=");
      return at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
    })
    .filter(signed)
    .sort(byKey)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return [reEncoded, asReceived].some((message) =>
    safeEqual(
      provided,
      createHmac("sha256", apiSecret).update(message).digest("hex"),
      "hex",
    ),
  );
}

/**
 * Webhook: HMAC over the raw request body, base64 encoded, in the
 * X-Shopify-Hmac-Sha256 header. It has to be the exact bytes Shopify sent,
 * so the body is read as text and never re-serialized before this runs.
 */
export function verifyWebhook(
  rawBody: string,
  header: string | null,
  apiSecret: string,
): boolean {
  if (!header) {
    return false;
  }

  const expected = createHmac("sha256", apiSecret)
    .update(rawBody, "utf8")
    .digest("base64");

  return safeEqual(header, expected, "base64");
}
