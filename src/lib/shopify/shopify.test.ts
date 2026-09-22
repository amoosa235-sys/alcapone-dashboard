import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { appOrigin, normalizeShopDomain } from "./config.ts";
import { verifyOAuthCallback, verifyWebhook } from "./hmac.ts";
import { readOAuthState } from "./state.ts";
import { normalizeShopifyEvent, type ShopifyOrder } from "./tickets.ts";

/**
 * Run with `npm test`. None of this touches the network: the point is that
 * the two signature checks and the normalisation can be exercised without a
 * Shopify store, since a mistake in either is invisible until a real install
 * silently fails.
 */

const SECRET = "shpss_test_secret";

test("a shop domain is accepted only when it really is one", () => {
  assert.equal(normalizeShopDomain("acme-supplies"), "acme-supplies.myshopify.com");
  assert.equal(normalizeShopDomain(" ACME-Supplies.myshopify.com "), "acme-supplies.myshopify.com");
  assert.equal(normalizeShopDomain("https://acme.myshopify.com/admin"), "acme.myshopify.com");

  // Each of these would otherwise end up in a URL this app fetches.
  for (const hostile of [
    "evil.com",
    "acme.myshopify.com.evil.com",
    "evil.com/acme.myshopify.com",
    "acme.myshopify.com:8080",
    "a@evil.myshopify.com",
    "acme.myshopify.com?x=1",
    "",
  ]) {
    assert.equal(normalizeShopDomain(hostile), null, hostile);
  }
});

/** Builds a callback URL signed over one of the two canonical forms. */
function signedCallback(
  params: Record<string, string>,
  form: "re-encoded" | "as-received",
  secret = SECRET,
) {
  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1));
  const message =
    form === "re-encoded"
      ? new URLSearchParams(sorted).toString()
      : sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  const search =
    "?" +
    sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") +
    `&hmac=${hmac}`;
  return { search, params: new URLSearchParams(search) };
}

test("the OAuth callback signature is accepted in either canonical form", () => {
  // A space encodes as + by URLSearchParams and as %20 by encodeURIComponent,
  // so this is a case where the two forms genuinely differ.
  const query = {
    code: "abc123",
    host: "YWNtZS5teXNob3BpZnkuY29tL2FkbWlu=",
    shop: "acme.myshopify.com",
    state: "nonce with space",
    timestamp: "1337178173",
  };

  for (const form of ["re-encoded", "as-received"] as const) {
    const { search, params } = signedCallback(query, form);
    assert.equal(verifyOAuthCallback(params, search, SECRET), true, form);
    assert.equal(verifyOAuthCallback(params, search, "wrong-secret"), false, form);
  }
});

test("the OAuth callback signature is rejected when it is forged or missing", () => {
  const forged = "?code=abc123&shop=acme.myshopify.com&hmac=deadbeef";
  assert.equal(
    verifyOAuthCallback(new URLSearchParams(forged), forged, SECRET),
    false,
  );

  const absent = "?code=abc123&shop=acme.myshopify.com";
  assert.equal(
    verifyOAuthCallback(new URLSearchParams(absent), absent, SECRET),
    false,
  );

  // Tampering with a signed parameter has to invalidate the signature.
  const { search, params } = signedCallback(
    { code: "abc123", shop: "acme.myshopify.com" },
    "re-encoded",
  );
  const swapped = search.replace("acme.myshopify.com", "evil.myshopify.com");
  assert.equal(
    verifyOAuthCallback(new URLSearchParams(swapped), swapped, SECRET),
    false,
  );
  assert.equal(verifyOAuthCallback(params, search, SECRET), true);
});

test("a webhook is accepted only when the body is the one that was signed", () => {
  const body = JSON.stringify({ id: 1, name: "#1001", note: "leave at the door" });
  const signature = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");

  assert.equal(verifyWebhook(body, signature, SECRET), true);
  assert.equal(verifyWebhook(`${body} `, signature, SECRET), false);
  assert.equal(verifyWebhook(body, signature, "wrong-secret"), false);
  assert.equal(verifyWebhook(body, null, SECRET), false);
  assert.equal(verifyWebhook(body, "AAAA", SECRET), false);
});

test("the OAuth state cookie only parses when it is well formed", () => {
  assert.deepEqual(readOAuthState("abc:acme.myshopify.com"), {
    nonce: "abc",
    shop: "acme.myshopify.com",
  });
  assert.equal(readOAuthState(":acme.myshopify.com"), null);
  assert.equal(readOAuthState("no-separator"), null);
  assert.equal(readOAuthState(undefined), null);
});

const ORDER: ShopifyOrder = {
  id: 9001,
  name: "#1001",
  order_number: 1001,
  email: "billing@example.com",
  note: "wrong size, need a swap",
  created_at: "2026-09-20T10:00:00Z",
  customer: {
    first_name: "Bea",
    last_name: "Khan",
    email: "bea@example.com",
    phone: "+447700900123",
  },
  line_items: [
    { name: "Wool coat", variant_title: "M / Navy", sku: "WC-M-NV", quantity: 1 },
  ],
};

test("an order with a note becomes a ticket, and one without does not", () => {
  const ticket = normalizeShopifyEvent("orders/create", ORDER, ORDER);
  assert.ok(ticket);
  assert.equal(ticket.externalId, "orders/create:9001");
  assert.equal(ticket.subject, "Note on order #1001");
  assert.equal(ticket.body, "wrong size, need a swap");
  assert.equal(ticket.customerName, "Bea Khan");
  // The customer's own address wins over the one on the order.
  assert.equal(ticket.customerEmail, "bea@example.com");
  assert.equal(ticket.customerPhone, "+447700900123");
  assert.equal(ticket.orderNumber, "#1001");
  assert.equal(ticket.externalThreadId, "order:9001");

  const quiet = { ...ORDER, note: "   " };
  assert.equal(normalizeShopifyEvent("orders/create", quiet, quiet), null);
});

test("a cancellation keeps the reason and the items", () => {
  const cancelled = {
    ...ORDER,
    cancelled_at: "2026-09-21T08:00:00Z",
    cancel_reason: "customer",
  };
  const ticket = normalizeShopifyEvent("orders/cancelled", cancelled, cancelled);
  assert.ok(ticket);
  assert.equal(ticket.subject, "Order #1001 was cancelled");
  assert.equal(ticket.receivedAt, "2026-09-21T08:00:00Z");
  assert.match(ticket.body, /Reason given: customer\./);
  assert.match(ticket.body, /1 x Wool coat \(M \/ Navy\) \[WC-M-NV\]/);
});

test("a refund takes its customer from the order it belongs to", () => {
  const refund = {
    id: 555,
    order_id: 9001,
    note: "damaged in transit",
    created_at: "2026-09-22T09:00:00Z",
    refund_line_items: [{ quantity: 1, line_item: { name: "Wool coat", sku: "WC-M-NV" } }],
  };

  const ticket = normalizeShopifyEvent("refunds/create", refund, ORDER);
  assert.ok(ticket);
  assert.equal(ticket.externalId, "refunds/create:555");
  assert.equal(ticket.subject, "Refund raised on order #1001");
  assert.equal(ticket.customerEmail, "bea@example.com");
  assert.equal(ticket.externalThreadId, "order:9001");
  assert.match(ticket.body, /damaged in transit/);
  assert.match(ticket.body, /1 x Wool coat/);

  // The order lookup is allowed to fail; the ticket is still worth having.
  const orphan = normalizeShopifyEvent("refunds/create", refund, null);
  assert.ok(orphan);
  assert.equal(orphan.orderNumber, null);
  assert.equal(orphan.customerEmail, null);
});

test("events nobody has to act on are not tickets", () => {
  assert.equal(normalizeShopifyEvent("orders/updated", ORDER, ORDER), null);
  assert.equal(normalizeShopifyEvent("orders/fulfilled", ORDER, ORDER), null);
  assert.equal(normalizeShopifyEvent("app/uninstalled", {}, null), null);
});

test("the callback origin prefers the forwarded host over the fallback", () => {
  assert.equal(
    appOrigin(
      new Headers({
        "x-forwarded-host": "alcapone-dashboard.vercel.app",
        "x-forwarded-proto": "https",
      }),
      "http://localhost:3000",
    ),
    "https://alcapone-dashboard.vercel.app",
  );
  assert.equal(appOrigin(new Headers(), "http://localhost:3000"), "http://localhost:3000");
});
