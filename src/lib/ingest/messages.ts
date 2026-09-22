import { afterCustomerMessage } from "@/lib/tickets/view";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

/**
 * Where an inbound message goes, whichever channel it came from.
 *
 * A ticket is a conversation. A message on a thread that already has a
 * ticket is added to that ticket, and the ticket goes back to the pile of
 * things needing a reply. A message on a new thread, or on a thread whose
 * ticket was closed long ago, starts a ticket of its own.
 *
 * Every step is keyed on the provider's message id, so the same message
 * arriving twice (a webhook retried, a mailbox checked twice, a missed
 * webhook caught up on later) is recognised and skipped.
 *
 * Runs as the service role, so every query filters by tenant itself.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type InboundMessage = {
  tenantId: string;
  channelId: string;
  externalId: string;
  threadId: string | null;
  subject: string | null;
  body: string | null;
  senderName: string | null;
  senderEmail: string | null;
  senderPhone?: string | null;
  orderNumber?: string | null;
  receivedAt: string;
  raw: Json;
};

export type IngestResult =
  | { outcome: "duplicate" }
  | { outcome: "created"; ticketId: string }
  | { outcome: "appended"; ticketId: string; reopened: boolean }
  | { outcome: "error"; error: string };

export async function ingestMessage(
  admin: Admin,
  message: InboundMessage,
  now: Date = new Date(),
): Promise<IngestResult> {
  if (await alreadyHave(admin, message)) {
    return { outcome: "duplicate" };
  }

  if (message.threadId) {
    const existing = await ticketForThread(admin, message);
    if (existing) {
      const next = afterCustomerMessage(
        { status: existing.status, closedAt: existing.closed_at },
        now,
      );
      if (next.kind === "append") {
        return append(admin, message, existing, next.status, next.reopened);
      }
    }
  }

  return create(admin, message);
}

async function alreadyHave(admin: Admin, message: InboundMessage): Promise<boolean> {
  const { data: seen } = await admin
    .from("ticket_messages")
    .select("id")
    .eq("tenant_id", message.tenantId)
    .eq("channel_id", message.channelId)
    .eq("external_id", message.externalId)
    .limit(1);

  if (seen?.length) {
    return true;
  }

  // A ticket created before messages had a table of their own carries the
  // message id itself.
  const { data: legacy } = await admin
    .from("tickets")
    .select("id")
    .eq("tenant_id", message.tenantId)
    .eq("channel_id", message.channelId)
    .eq("external_id", message.externalId)
    .limit(1);

  return Boolean(legacy?.length);
}

type ThreadTicket = {
  id: string;
  status: "unopened" | "pending" | "waiting" | "closed";
  closed_at: string | null;
  last_message_at: string;
  merged_into_ticket_id: string | null;
};

/**
 * The ticket a thread belongs to. A ticket merged into another hands its
 * conversation on to the one it was merged into.
 */
async function ticketForThread(
  admin: Admin,
  message: InboundMessage,
): Promise<ThreadTicket | null> {
  const { data } = await admin
    .from("tickets")
    .select("id, status, closed_at, last_message_at, merged_into_ticket_id")
    .eq("tenant_id", message.tenantId)
    .eq("channel_id", message.channelId)
    .eq("external_thread_id", message.threadId ?? "")
    .order("received_at", { ascending: false })
    .limit(1);

  let ticket: ThreadTicket | null = data?.[0] ?? null;

  for (let hop = 0; ticket?.merged_into_ticket_id && hop < 5; hop += 1) {
    const { data: target } = await admin
      .from("tickets")
      .select("id, status, closed_at, last_message_at, merged_into_ticket_id")
      .eq("tenant_id", message.tenantId)
      .eq("id", ticket.merged_into_ticket_id)
      .maybeSingle();
    ticket = target ?? null;
  }

  return ticket;
}

async function append(
  admin: Admin,
  message: InboundMessage,
  ticket: ThreadTicket,
  status: ThreadTicket["status"],
  reopened: boolean,
): Promise<IngestResult> {
  const { data: inserted, error } = await admin
    .from("ticket_messages")
    .upsert(
      {
        tenant_id: message.tenantId,
        ticket_id: ticket.id,
        channel_id: message.channelId,
        external_id: message.externalId,
        sender_name: message.senderName,
        sender_email: message.senderEmail,
        subject: message.subject,
        body: message.body,
        received_at: message.receivedAt,
        raw: message.raw,
      },
      { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (error) {
    return { outcome: "error", error: error.message };
  }
  if (!inserted) {
    return { outcome: "duplicate" };
  }

  const newer = Date.parse(message.receivedAt) > Date.parse(ticket.last_message_at);
  const { error: updateError } = await admin
    .from("tickets")
    .update({
      status,
      ...(reopened ? { closed_at: null } : {}),
      ...(newer ? { last_message_at: message.receivedAt } : {}),
    })
    .eq("tenant_id", message.tenantId)
    .eq("id", ticket.id);

  if (updateError) {
    return { outcome: "error", error: updateError.message };
  }

  return { outcome: "appended", ticketId: ticket.id, reopened };
}

async function create(admin: Admin, message: InboundMessage): Promise<IngestResult> {
  const { data: ticket, error } = await admin
    .from("tickets")
    .upsert(
      {
        tenant_id: message.tenantId,
        channel_id: message.channelId,
        external_id: message.externalId,
        external_thread_id: message.threadId,
        subject: message.subject,
        body: message.body,
        customer_name: message.senderName,
        customer_email: message.senderEmail,
        customer_phone: message.senderPhone ?? null,
        order_number: message.orderNumber ?? null,
        received_at: message.receivedAt,
        last_message_at: message.receivedAt,
        raw: message.raw,
      },
      { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (error) {
    return { outcome: "error", error: error.message };
  }
  if (!ticket) {
    return { outcome: "duplicate" };
  }

  const { error: messageError } = await admin.from("ticket_messages").upsert(
    {
      tenant_id: message.tenantId,
      ticket_id: ticket.id,
      channel_id: message.channelId,
      external_id: message.externalId,
      sender_name: message.senderName,
      sender_email: message.senderEmail,
      subject: message.subject,
      body: message.body,
      received_at: message.receivedAt,
      raw: message.raw,
    },
    { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
  );

  if (messageError) {
    // The ticket exists and carries the message itself, so nothing is lost;
    // the timeline falls back to the ticket's own body.
    console.error("ingest: ticket created without its message row", {
      ticketId: ticket.id,
      code: messageError.code,
      message: messageError.message,
    });
  }

  return { outcome: "created", ticketId: ticket.id };
}

export type OrderEventInput = {
  tenantId: string;
  channelId: string;
  externalId: string;
  kind: "cancelled" | "refunded";
  orderNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  summary: string;
  occurredAt: string;
  raw: Json;
};

/** Order history, kept once per provider event. */
export async function recordOrderEvent(
  admin: Admin,
  event: OrderEventInput,
): Promise<{ recorded: boolean; error: string | null }> {
  const { data, error } = await admin
    .from("order_events")
    .upsert(
      {
        tenant_id: event.tenantId,
        channel_id: event.channelId,
        external_id: event.externalId,
        kind: event.kind,
        order_number: event.orderNumber,
        customer_name: event.customerName,
        customer_email: event.customerEmail,
        customer_phone: event.customerPhone,
        summary: event.summary,
        occurred_at: event.occurredAt,
        raw: event.raw,
      },
      { onConflict: "tenant_id,channel_id,external_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  return { recorded: Boolean(data), error: error?.message ?? null };
}
