import { fetchGraphToken, fetchMessagesSince } from "./graph";
import { normalizeGraphMessage } from "./tickets";
import { processTicket } from "@/lib/pipeline/process";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

type Admin = ReturnType<typeof createAdminClient>;

export type MailboxSyncResult = {
  channelId: string;
  mailbox: string;
  fetched: number;
  created: number;
  error: string | null;
};

/**
 * Pulls whatever has arrived in one mailbox since the last run and turns each
 * message into a ticket.
 *
 * The cursor is the channel's last_synced_at, and it only moves once the
 * messages before it are in. A failure part way through leaves the cursor
 * where it was, so the next run picks the same messages up again; the unique
 * index on (tenant_id, channel_id, external_id) is what stops that becoming
 * duplicates.
 */
export async function syncMailbox(
  admin: Admin,
  channel: {
    id: string;
    tenant_id: string;
    external_account_id: string | null;
    config: Json;
    last_synced_at: string | null;
  },
): Promise<MailboxSyncResult> {
  const mailbox = channel.external_account_id ?? "";
  const result: MailboxSyncResult = {
    channelId: channel.id,
    mailbox,
    fetched: 0,
    created: 0,
    error: null,
  };

  const config = (channel.config ?? {}) as Record<string, unknown>;
  const tenantId = typeof config.tenant_id === "string" ? config.tenant_id : null;
  const clientId = typeof config.client_id === "string" ? config.client_id : null;

  const { data: secret } = await admin
    .from("channel_secrets")
    .select("extra")
    .eq("channel_id", channel.id)
    .maybeSingle();

  const extra = (secret?.extra ?? {}) as Record<string, unknown>;
  const clientSecret =
    typeof extra.client_secret === "string" ? extra.client_secret : null;

  if (!mailbox || !tenantId || !clientId || !clientSecret) {
    result.error =
      "This mailbox is missing part of its app registration. Re-enter it on the channels page.";
    await markChannel(admin, channel, "error", result.error);
    return result;
  }

  let messages;
  try {
    const token = await fetchGraphToken({ tenantId, clientId, clientSecret });
    messages = await fetchMessagesSince(token, mailbox, channel.last_synced_at);
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Graph request failed.";
    await markChannel(admin, channel, "error", result.error);
    return result;
  }

  result.fetched = messages.length;
  let newest = channel.last_synced_at;

  for (const message of messages) {
    const email = normalizeGraphMessage(message);
    if (!email) {
      continue;
    }

    const { data: inserted, error } = await admin
      .from("tickets")
      .upsert(
        {
          tenant_id: channel.tenant_id,
          channel_id: channel.id,
          external_id: email.externalId,
          external_thread_id: email.externalThreadId,
          subject: email.subject,
          body: email.body,
          customer_name: email.customerName,
          customer_email: email.customerEmail,
          received_at: email.receivedAt,
          last_message_at: email.receivedAt,
          raw: message as unknown as Json,
        },
        { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (error) {
      result.error = error.message;
      await markChannel(admin, channel, "error", error.message);
      return result;
    }

    if (inserted) {
      result.created += 1;
      await processTicket(admin, channel.tenant_id, inserted.id);
    }

    if (!newest || email.receivedAt > newest) {
      newest = email.receivedAt;
    }
  }

  await admin
    .from("channels")
    .update({
      status: "connected",
      last_error: null,
      last_synced_at: newest ?? new Date().toISOString(),
    })
    .eq("id", channel.id)
    .eq("tenant_id", channel.tenant_id);

  return result;
}

async function markChannel(
  admin: Admin,
  channel: { id: string; tenant_id: string },
  status: "error" | "connected",
  message: string | null,
): Promise<void> {
  await admin
    .from("channels")
    .update({ status, last_error: message })
    .eq("id", channel.id)
    .eq("tenant_id", channel.tenant_id);
}
