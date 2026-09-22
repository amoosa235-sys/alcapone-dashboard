import { createClient } from "@/lib/supabase/server";
import type { Enums, Json, Tables } from "@/types/database";
import { TICKET_STATUSES } from "@/types/database";

/**
 * Everything the ticket pages read.
 *
 * All of it runs under the signed-in user's session, so row level security is
 * what scopes it to their workspace. There is deliberately no tenant_id filter
 * anywhere in this file: if one were needed, the policies would not be doing
 * their job.
 *
 * Classifications are fetched separately rather than embedded, because only
 * the live one matters and filtering an embedded resource by superseded_at is
 * easy to get subtly wrong. Two plain queries say what they mean.
 */

export type ClassificationView = {
  category: Enums<"ticket_category">;
  confidence: number | null;
  summary: string | null;
  orderNumber: string | null;
  contactNumber: string | null;
  customerName: string | null;
  itemNeedingAttention: string | null;
  orderedItems: { name: string; sku: string | null; quantity: number | null }[];
  model: string | null;
  classifiedAt: string;
};

export type TicketListItem = {
  id: string;
  subject: string | null;
  body: string | null;
  status: Enums<"ticket_status">;
  customerName: string | null;
  customerEmail: string | null;
  orderNumber: string | null;
  receivedAt: string;
  channelType: Enums<"channel_type"> | null;
  channelName: string | null;
  classification: ClassificationView | null;
  duplicateCount: number;
};

export type TicketDetail = TicketListItem & {
  channelId: string | null;
  channelStatus: Enums<"channel_status"> | null;
  externalId: string | null;
  customerPhone: string | null;
  closedAt: string | null;
  duplicates: {
    ticketId: string;
    subject: string | null;
    channelType: Enums<"channel_type"> | null;
    receivedAt: string;
    score: number | null;
    matchReason: string | null;
    isPrimary: boolean;
  }[];
  replies: Tables<"ticket_replies">[];
};

/** The ordered_items column as it is actually written by the pipeline. */
function readOrderedItems(value: Json): ClassificationView["orderedItems"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string") {
      return [];
    }
    return [
      {
        name: row.name,
        sku: typeof row.sku === "string" ? row.sku : null,
        quantity: typeof row.quantity === "number" ? row.quantity : null,
      },
    ];
  });
}

function toClassification(
  row: Tables<"ticket_classifications">,
): ClassificationView {
  return {
    category: row.category,
    confidence: row.confidence === null ? null : Number(row.confidence),
    summary: row.summary,
    orderNumber: row.order_number,
    contactNumber: row.contact_number,
    customerName: row.customer_name,
    itemNeedingAttention: row.item_needing_attention,
    orderedItems: readOrderedItems(row.ordered_items),
    model: row.model,
    classifiedAt: row.created_at,
  };
}

/** The live classification for a set of tickets, keyed by ticket id. */
async function liveClassifications(
  ticketIds: string[],
): Promise<Map<string, ClassificationView>> {
  if (!ticketIds.length) {
    return new Map();
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ticket_classifications")
    .select("*")
    .is("superseded_at", null)
    .in("ticket_id", ticketIds);

  return new Map((data ?? []).map((row) => [row.ticket_id, toClassification(row)]));
}

/** How many other tickets each of these is linked to, keyed by ticket id. */
async function duplicateCounts(
  ticketIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ticketIds.length) {
    return counts;
  }

  const supabase = await createClient();

  // A pair is stored once, on whichever side each ticket happens to sit, so
  // both columns have to be asked. Two indexed queries beat reading the whole
  // table and sorting it out here.
  const [asPrimary, asDuplicate] = await Promise.all([
    supabase
      .from("duplicate_links")
      .select("primary_ticket_id")
      .neq("status", "rejected")
      .in("primary_ticket_id", ticketIds),
    supabase
      .from("duplicate_links")
      .select("duplicate_ticket_id")
      .neq("status", "rejected")
      .in("duplicate_ticket_id", ticketIds),
  ]);

  for (const row of asPrimary.data ?? []) {
    counts.set(
      row.primary_ticket_id,
      (counts.get(row.primary_ticket_id) ?? 0) + 1,
    );
  }
  for (const row of asDuplicate.data ?? []) {
    counts.set(
      row.duplicate_ticket_id,
      (counts.get(row.duplicate_ticket_id) ?? 0) + 1,
    );
  }

  return counts;
}

export async function countTicketsByStatus(): Promise<
  Record<Enums<"ticket_status">, number>
> {
  const supabase = await createClient();

  const results = await Promise.all(
    TICKET_STATUSES.map(async (status) => {
      const { count } = await supabase
        .from("tickets")
        .select("id", { head: true, count: "exact" })
        .eq("status", status)
        .is("merged_into_ticket_id", null);
      return [status, count ?? 0] as const;
    }),
  );

  return Object.fromEntries(results) as Record<Enums<"ticket_status">, number>;
}

export async function listTickets(
  status: Enums<"ticket_status">,
  limit = 50,
): Promise<TicketListItem[]> {
  const supabase = await createClient();

  const { data: tickets } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, status, customer_name, customer_email, order_number, received_at, channel_id, channels(type, display_name)",
    )
    .eq("status", status)
    .is("merged_into_ticket_id", null)
    .order("received_at", { ascending: false })
    .limit(limit);

  const rows = tickets ?? [];
  const ids = rows.map((row) => row.id);
  const [classifications, duplicates] = await Promise.all([
    liveClassifications(ids),
    duplicateCounts(ids),
  ]);

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    orderNumber: row.order_number,
    receivedAt: row.received_at,
    channelType: row.channels?.type ?? null,
    channelName: row.channels?.display_name ?? null,
    classification: classifications.get(row.id) ?? null,
    duplicateCount: duplicates.get(row.id) ?? 0,
  }));
}

export async function getTicket(id: string): Promise<TicketDetail | null> {
  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, status, customer_name, customer_email, customer_phone, order_number, received_at, closed_at, external_id, channel_id, channels(type, status, display_name)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!ticket) {
    return null;
  }

  const [classifications, links, replies] = await Promise.all([
    liveClassifications([ticket.id]),
    supabase
      .from("duplicate_links")
      .select("primary_ticket_id, duplicate_ticket_id, score, match_reason, status")
      .neq("status", "rejected")
      .or(`primary_ticket_id.eq.${ticket.id},duplicate_ticket_id.eq.${ticket.id}`),
    supabase
      .from("ticket_replies")
      .select("*")
      .eq("ticket_id", ticket.id)
      .order("created_at", { ascending: true }),
  ]);

  const otherIds = (links.data ?? []).map((link) =>
    link.primary_ticket_id === ticket.id
      ? link.duplicate_ticket_id
      : link.primary_ticket_id,
  );

  const { data: others } = otherIds.length
    ? await supabase
        .from("tickets")
        .select("id, subject, received_at, channels(type)")
        .in("id", otherIds)
    : { data: [] };

  const otherById = new Map((others ?? []).map((row) => [row.id, row]));

  return {
    id: ticket.id,
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    customerName: ticket.customer_name,
    customerEmail: ticket.customer_email,
    customerPhone: ticket.customer_phone,
    orderNumber: ticket.order_number,
    receivedAt: ticket.received_at,
    closedAt: ticket.closed_at,
    externalId: ticket.external_id,
    channelId: ticket.channel_id,
    channelType: ticket.channels?.type ?? null,
    channelStatus: ticket.channels?.status ?? null,
    channelName: ticket.channels?.display_name ?? null,
    classification: classifications.get(ticket.id) ?? null,
    duplicateCount: otherIds.length,
    duplicates: (links.data ?? []).flatMap((link) => {
      const otherId =
        link.primary_ticket_id === ticket.id
          ? link.duplicate_ticket_id
          : link.primary_ticket_id;
      const other = otherById.get(otherId);
      if (!other) {
        return [];
      }
      return [
        {
          ticketId: otherId,
          subject: other.subject,
          channelType: other.channels?.type ?? null,
          receivedAt: other.received_at,
          score: link.score === null ? null : Number(link.score),
          matchReason: link.match_reason,
          isPrimary: link.primary_ticket_id === otherId,
        },
      ];
    }),
    replies: replies.data ?? [],
  };
}
