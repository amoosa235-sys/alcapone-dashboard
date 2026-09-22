import { listOrdersUpdatedSince, registerWebhooks } from "./admin-api";
import { webhookUrlFromOrigin } from "./config";
import { outcomesFromOrder } from "./tickets";
import { ingestMessage, recordOrderEvent } from "@/lib/ingest/messages";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Catching up on a store, for when webhooks did not arrive.
 *
 * Shopify retries a failed webhook for a while and then gives up, and it
 * can drop a subscription that keeps failing. Nothing on our side would
 * notice either. So a few times a day this checks the store's webhook
 * subscriptions are still there (putting back any that are not) and reads
 * the orders that changed since it last looked, filing anything that should
 * have arrived. Ingestion recognises what it already has, so this only ever
 * adds what was missed.
 */

export const RECONCILE_EVERY_HOURS = 6;

/** How far back the first catch-up for a store reaches. */
export const FIRST_RECONCILE_LOOKBACK_HOURS = 72;

export type ReconcileResult = {
  channelId: string;
  shop: string;
  skipped: boolean;
  ordersChecked: number;
  ticketsCreated: number;
  eventsRecorded: number;
  webhooksRepaired: number;
  error: string | null;
};

export async function reconcileStore(
  admin: Admin,
  channel: {
    id: string;
    tenant_id: string;
    external_account_id: string | null;
    config: Json;
  },
  origin: string,
  deadline: number,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const shop = channel.external_account_id ?? "";
  const config = (channel.config ?? {}) as Record<string, Json>;
  const result: ReconcileResult = {
    channelId: channel.id,
    shop,
    skipped: false,
    ordersChecked: 0,
    ticketsCreated: 0,
    eventsRecorded: 0,
    webhooksRepaired: 0,
    error: null,
  };

  const last =
    typeof config.last_reconciled_at === "string"
      ? Date.parse(config.last_reconciled_at)
      : Number.NaN;
  if (
    Number.isFinite(last) &&
    now.getTime() - last < RECONCILE_EVERY_HOURS * 3_600_000
  ) {
    result.skipped = true;
    return result;
  }

  const { data: secret } = await admin
    .from("channel_secrets")
    .select("access_token")
    .eq("channel_id", channel.id)
    .maybeSingle();

  if (!shop || !secret?.access_token) {
    result.error = "This store has no access token. Connect it again from the Channels page.";
    return result;
  }

  const address = webhookUrlFromOrigin(origin);
  const registrations = address
    ? await registerWebhooks(shop, secret.access_token, address)
    : [];
  const previous = Array.isArray(config.webhooks)
    ? (config.webhooks as { topic?: string; id?: number | null }[])
    : [];
  result.webhooksRepaired = registrations.filter(
    (entry) =>
      !entry.error &&
      !previous.some((old) => old.topic === entry.topic && old.id === entry.id),
  ).length;

  const since = Number.isFinite(last)
    ? new Date(last - 3_600_000).toISOString()
    : new Date(now.getTime() - FIRST_RECONCILE_LOOKBACK_HOURS * 3_600_000).toISOString();

  const listing = await listOrdersUpdatedSince(shop, secret.access_token, since);
  result.ordersChecked = listing.orders.length;

  for (const order of listing.orders) {
    if (Date.now() > deadline) {
      result.error = "Stopped at the time limit; the rest is picked up next run.";
      break;
    }
    for (const outcome of outcomesFromOrder(order)) {
      if (outcome.kind === "ticket") {
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
          raw: order as unknown as Json,
        });
        if (filed.outcome === "created") {
          result.ticketsCreated += 1;
        }
      } else {
        const event = outcome.event;
        const recorded = await recordOrderEvent(admin, {
          tenantId: channel.tenant_id,
          channelId: channel.id,
          ...event,
          raw: {} as Json,
        });
        if (recorded.recorded) {
          result.eventsRecorded += 1;
        }
      }
    }
  }

  const failedHooks = registrations.filter((entry) => entry.error);
  const finished = !listing.error && !listing.rateLimited && !result.error;
  if (listing.error) {
    result.error = listing.error;
  } else if (listing.rateLimited) {
    result.error = "Shopify asked us to slow down; the rest is picked up next run.";
  }

  await admin
    .from("channels")
    .update({
      config: {
        ...config,
        ...(registrations.length ? { webhooks: registrations as unknown as Json } : {}),
        // Only a complete pass moves the marker, so a partial one is redone.
        ...(finished ? { last_reconciled_at: now.toISOString() } : {}),
      },
      ...(failedHooks.length
        ? {
            status: "error" as const,
            last_error: `Could not subscribe to ${failedHooks.map((entry) => entry.topic).join(", ")}`,
          }
        : registrations.length
          ? { status: "connected" as const, last_error: null }
          : {}),
    })
    .eq("id", channel.id)
    .eq("tenant_id", channel.tenant_id);

  return result;
}
