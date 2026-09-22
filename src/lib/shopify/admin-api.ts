import type { ShopifyOrder } from "./tickets";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_WEBHOOK_TOPICS,
  type ShopifyCredentials,
} from "./config";

/** Thin wrapper over the bits of Shopify's Admin API this app needs. */

export type AccessTokenResponse = {
  access_token: string;
  scope: string;
};

/**
 * Trades the one-time code from the OAuth callback for a permanent offline
 * access token for this shop.
 */
export async function exchangeCodeForToken(
  shop: string,
  code: string,
  credentials: ShopifyCredentials,
): Promise<AccessTokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: credentials.apiKey,
      client_secret: credentials.apiSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Shopify refused the token exchange (${response.status}). The code may have already been used.`,
    );
  }

  const body = (await response.json()) as Partial<AccessTokenResponse>;
  if (!body.access_token) {
    throw new Error("Shopify returned no access token.");
  }

  return { access_token: body.access_token, scope: body.scope ?? "" };
}

type WebhookSubscription = { id: number; topic: string; address: string };

async function listWebhooks(
  shop: string,
  accessToken: string,
): Promise<WebhookSubscription[]> {
  const response = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json?limit=250`,
    { headers: { "X-Shopify-Access-Token": accessToken } },
  );

  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { webhooks?: WebhookSubscription[] };
  return body.webhooks ?? [];
}

export type WebhookRegistration = {
  topic: string;
  id: number | null;
  error: string | null;
};

/**
 * Subscribes the shop to every topic this app ingests, pointing at our
 * receiver. Re-registering is safe: an existing subscription on the same
 * topic and address is left alone, and one pointing somewhere stale is
 * updated rather than duplicated.
 */
export async function registerWebhooks(
  shop: string,
  accessToken: string,
  address: string,
): Promise<WebhookRegistration[]> {
  const existing = await listWebhooks(shop, accessToken);

  return Promise.all(
    SHOPIFY_WEBHOOK_TOPICS.map(async (topic): Promise<WebhookRegistration> => {
      const match = existing.find((hook) => hook.topic === topic);

      if (match?.address === address) {
        return { topic, id: match.id, error: null };
      }

      const url = match
        ? `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${match.id}.json`
        : `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`;

      const response = await fetch(url, {
        method: match ? "PUT" : "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook: { topic, address, format: "json" },
        }),
      });

      if (!response.ok) {
        return {
          topic,
          id: null,
          error: `${response.status} ${await response.text()}`.slice(0, 200),
        };
      }

      const body = (await response.json()) as { webhook?: { id: number } };
      return { topic, id: body.webhook?.id ?? null, error: null };
    }),
  );
}

/**
 * Refund payloads carry no customer, so the order is fetched to fill in who
 * this is about. A failure here is not fatal: the ticket is still created,
 * just without the contact details.
 */
export async function fetchOrder(
  shop: string,
  accessToken: string,
  orderId: number,
): Promise<ShopifyOrder | null> {
  try {
    const response = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { order?: ShopifyOrder };
    return body.order ?? null;
  } catch {
    return null;
  }
}

export type OrdersPage = {
  orders: ShopifyOrder[];
  /** Set when Shopify said to slow down; the rest waits for the next run. */
  rateLimited: boolean;
  error: string | null;
};

/**
 * Orders changed since a moment, following Shopify's page links, for
 * catching up on webhooks that never arrived. Stops at the page budget, or
 * as soon as Shopify rate limits the store, and says which.
 */
export async function listOrdersUpdatedSince(
  shop: string,
  accessToken: string,
  since: string,
  maxPages = 4,
): Promise<OrdersPage> {
  const first = new URL(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json`,
  );
  first.searchParams.set("status", "any");
  first.searchParams.set("updated_at_min", since);
  first.searchParams.set("limit", "250");

  const orders: ShopifyOrder[] = [];
  let next: string | null = first.toString();

  for (let page = 0; next && page < maxPages; page += 1) {
    let response: Response;
    try {
      response = await fetch(next, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
    } catch (error) {
      return {
        orders,
        rateLimited: false,
        error: error instanceof Error ? error.message : "Could not reach Shopify.",
      };
    }

    if (response.status === 429) {
      return { orders, rateLimited: true, error: null };
    }

    if (!response.ok) {
      return {
        orders,
        rateLimited: false,
        error: `Shopify would not list orders (${response.status}).`,
      };
    }

    const body = (await response.json()) as { orders?: ShopifyOrder[] };
    orders.push(...(body.orders ?? []));
    next = nextPageLink(response.headers.get("link"), shop);
  }

  return { orders, rateLimited: false, error: null };
}

/**
 * The rel="next" URL from Shopify's Link header, and only when it points
 * back at the same store, since the request carries that store's token.
 */
export function nextPageLink(header: string | null, shop: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) {
      try {
        const url = new URL(match[1]);
        return url.hostname === shop && url.protocol === "https:" ? url.toString() : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
