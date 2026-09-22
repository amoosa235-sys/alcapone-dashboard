import { NextResponse, type NextRequest } from "next/server";

import { fetchOrder } from "@/lib/shopify/admin-api";
import { normalizeShopDomain, shopifyCredentials } from "@/lib/shopify/config";
import { verifyWebhook } from "@/lib/shopify/hmac";
import {
  normalizeShopifyEvent,
  type ShopifyOrder,
  type ShopifyRefund,
} from "@/lib/shopify/tickets";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

/**
 * Receives Shopify webhooks. This is the one route in the app that runs
 * without a session, so the HMAC is the only thing standing between a caller
 * and the database, and it is checked before anything else is read.
 *
 * Shopify retries anything that is not a 2xx, so a payload we recognize but
 * have nothing to do with is acknowledged rather than rejected. Only a
 * genuine failure on our side returns a 5xx and earns a retry.
 */
export async function POST(request: NextRequest) {
  const credentials = shopifyCredentials();
  if (!credentials) {
    return new NextResponse("Shopify is not configured", { status: 503 });
  }

  // The exact bytes Shopify signed. Parsing before verifying would mean
  // trusting the payload to decide whether to trust the payload.
  const rawBody = await request.text();

  if (
    !verifyWebhook(
      rawBody,
      request.headers.get("x-shopify-hmac-sha256"),
      credentials.apiSecret,
    )
  ) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const topic = request.headers.get("x-shopify-topic") ?? "";
  const shop = normalizeShopDomain(
    request.headers.get("x-shopify-shop-domain") ?? "",
  );

  if (!shop || !topic) {
    return new NextResponse("Missing topic or shop", { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Body was not JSON", { status: 400 });
  }

  const admin = createAdminClient();

  // A shop domain belongs to one tenant in v1. Taking the oldest match rather
  // than insisting on exactly one keeps a second install from turning every
  // webhook into a 500 that Shopify then retries forever.
  const { data: channels, error: channelError } = await admin
    .from("channels")
    .select("id, tenant_id")
    .eq("type", "shopify")
    .eq("external_account_id", shop)
    .order("created_at", { ascending: true })
    .limit(1);

  if (channelError) {
    return new NextResponse("Lookup failed", { status: 500 });
  }

  const channel = channels?.[0];

  if (!channel) {
    // A store we do not have connected, or one already removed. Nothing to
    // do, and no reason to make Shopify keep trying.
    return new NextResponse("No such channel", { status: 200 });
  }

  if (topic === "app/uninstalled") {
    await admin
      .from("channels")
      .update({ status: "disabled", last_error: "The app was uninstalled from this store." })
      .eq("id", channel.id)
      .eq("tenant_id", channel.tenant_id);
    // The token is dead the moment the app is uninstalled; dropping it means
    // there is nothing left to leak.
    await admin.from("channel_secrets").delete().eq("channel_id", channel.id);
    return new NextResponse("Uninstalled", { status: 200 });
  }

  if (topic === "shop/redact") {
    // Shopify sends this once the store has been gone long enough that its
    // data must be erased, so the tickets go with the channel rather than
    // being orphaned by the channel_id foreign key's on delete set null.
    await admin
      .from("tickets")
      .delete()
      .eq("tenant_id", channel.tenant_id)
      .eq("channel_id", channel.id);
    await admin
      .from("channels")
      .delete()
      .eq("id", channel.id)
      .eq("tenant_id", channel.tenant_id);
    return new NextResponse("Redacted", { status: 200 });
  }

  if (topic === "customers/redact") {
    const email = (payload as { customer?: { email?: string } }).customer?.email;
    if (email) {
      await admin
        .from("tickets")
        .update({
          customer_name: null,
          customer_email: null,
          customer_phone: null,
          body: "[redacted at the customer's request]",
          raw: {},
        })
        .eq("tenant_id", channel.tenant_id)
        .eq("channel_id", channel.id)
        // % and _ are wildcards to ilike, and an underscore in an address is
        // ordinary, so escape them rather than redact somebody else's ticket.
        .ilike("customer_email", email.replace(/[\\%_]/g, "\\$&"));
    }
    return new NextResponse("Redacted", { status: 200 });
  }

  if (topic === "customers/data_request") {
    // Shopify requires the endpoint to exist and answer. Fulfilling the
    // request itself is a manual job for whoever owns the store.
    return new NextResponse("Received", { status: 200 });
  }

  const order = await resolveOrder(admin, channel.id, shop, topic, payload);
  const ticket = normalizeShopifyEvent(topic, payload, order);

  if (!ticket) {
    return new NextResponse("Nothing to do", { status: 200 });
  }

  const { error: insertError } = await admin.from("tickets").upsert(
    {
      tenant_id: channel.tenant_id,
      channel_id: channel.id,
      external_id: ticket.externalId,
      external_thread_id: ticket.externalThreadId,
      subject: ticket.subject,
      body: ticket.body,
      customer_name: ticket.customerName,
      customer_email: ticket.customerEmail,
      customer_phone: ticket.customerPhone,
      order_number: ticket.orderNumber,
      received_at: ticket.receivedAt,
      last_message_at: ticket.receivedAt,
      raw: payload as Json,
    },
    { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
  );

  if (insertError) {
    // A 5xx is the honest answer: Shopify will retry and we would rather have
    // the ticket late than not at all.
    return new NextResponse(insertError.message, { status: 500 });
  }

  return new NextResponse("Received", { status: 200 });
}

/**
 * Order events carry the order. Refund events carry only an order id, so the
 * order is fetched to fill in who the customer is.
 */
async function resolveOrder(
  admin: ReturnType<typeof createAdminClient>,
  channelId: string,
  shop: string,
  topic: string,
  payload: unknown,
): Promise<ShopifyOrder | null> {
  if (topic.startsWith("orders/")) {
    return payload as ShopifyOrder;
  }

  if (topic !== "refunds/create") {
    return null;
  }

  const orderId = (payload as ShopifyRefund).order_id;
  if (orderId == null) {
    return null;
  }

  const { data: secret } = await admin
    .from("channel_secrets")
    .select("access_token")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (!secret?.access_token) {
    return null;
  }

  return fetchOrder(shop, secret.access_token, orderId);
}
