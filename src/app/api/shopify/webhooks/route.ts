import { NextResponse, after, type NextRequest } from "next/server";

import { fetchOrder } from "@/lib/shopify/admin-api";
import { normalizeShopDomain, shopifyCredentials } from "@/lib/shopify/config";
import { verifyWebhook } from "@/lib/shopify/hmac";
import {
  normalizeShopifyEvent,
  type ShopifyOrder,
  type ShopifyRefund,
} from "@/lib/shopify/tickets";
import { ingestMessage, recordOrderEvent } from "@/lib/ingest/messages";
import { redactCustomer } from "@/lib/ingest/redact";
import { processTicket } from "@/lib/pipeline/process";
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
    const request = payload as {
      customer?: { email?: string | null };
      orders_to_redact?: number[];
    };
    const erased = await redactCustomer(admin, {
      tenantId: channel.tenant_id,
      email: request.customer?.email ?? null,
      orderIds: Array.isArray(request.orders_to_redact)
        ? request.orders_to_redact.filter((id) => typeof id === "number")
        : [],
    });
    if (erased.error) {
      // Erasure is a legal obligation, so a failure earns a retry rather
      // than an acknowledgement. Every step is safe to repeat.
      return new NextResponse("Redaction failed", { status: 500 });
    }
    return new NextResponse("Redacted", { status: 200 });
  }

  if (topic === "customers/data_request") {
    // Shopify requires the endpoint to exist and answer. Fulfilling the
    // request itself is a manual job for whoever owns the store.
    return new NextResponse("Received", { status: 200 });
  }

  const order = await resolveOrder(admin, channel.id, shop, topic, payload);
  const outcome = normalizeShopifyEvent(topic, payload, order);

  if (!outcome) {
    return new NextResponse("Nothing to do", { status: 200 });
  }

  if (outcome.kind === "event") {
    // A cancellation or refund is the store's own staff acting. It is kept
    // as order history beside the customer's tickets, not as a ticket.
    const recorded = await recordOrderEvent(admin, {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      ...outcome.event,
      raw: payload as Json,
    });
    if (recorded.error) {
      return new NextResponse("Could not record the event", { status: 500 });
    }
    return new NextResponse("Received", { status: 200 });
  }

  const ticket = outcome.ticket;
  const filed = await ingestMessage(admin, {
    tenantId: channel.tenant_id,
    channelId: channel.id,
    externalId: ticket.externalId,
    threadId: ticket.externalThreadId,
    subject: ticket.subject,
    body: ticket.body,
    senderName: ticket.customerName,
    senderEmail: ticket.customerEmail,
    senderPhone: ticket.customerPhone,
    orderNumber: ticket.orderNumber,
    receivedAt: ticket.receivedAt,
    raw: payload as Json,
  });

  if (filed.outcome === "error") {
    // A 5xx is the honest answer: Shopify will retry and we would rather have
    // the ticket late than not at all.
    return new NextResponse("Could not file the ticket", { status: 500 });
  }

  if (filed.outcome === "created") {
    // Classification and duplicate matching run after the response. Shopify
    // gives a webhook five seconds and retries anything slower, and a retry
    // here would mean classifying the same ticket twice. If this is cut
    // short, the scheduled job finds the ticket still pending and finishes.
    const ticketId = filed.ticketId;
    const tenantId = channel.tenant_id;
    after(async () => {
      const result = await processTicket(createAdminClient(), tenantId, ticketId);
      if (result.classificationError) {
        console.error("shopify: classification failed", {
          ticketId,
          error: result.classificationError,
        });
      }
    });
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
