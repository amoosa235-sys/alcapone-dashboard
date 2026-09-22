import { SEND_TIMEOUT_MS } from "@/lib/replies/outcome";
import { createClient } from "@/lib/supabase/server";
import type { Enums, Json, Tables } from "@/types/database";
import { TICKET_STATUSES } from "@/types/database";

import { PAGE_SIZE, queueOrder, type TicketFilters } from "./view";

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

type Supabase = Awaited<ReturnType<typeof createClient>>;

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
  source: "claude" | "agent";
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
  lastMessageAt: string;
  assignedTo: string | null;
  classificationStatus: string;
  channelType: Enums<"channel_type"> | null;
  channelName: string | null;
  classification: ClassificationView | null;
  duplicateCount: number;
};

export type TimelineEntry =
  | {
      kind: "customer";
      id: string;
      at: string;
      senderName: string | null;
      senderEmail: string | null;
      subject: string | null;
      body: string | null;
      /** Set when the message came from a ticket merged into this one. */
      fromMergedTicket: boolean;
    }
  | {
      kind: "reply";
      id: string;
      at: string;
      body: string;
      author: Enums<"reply_author">;
      editedByAgent: boolean;
      sendNote: string | null;
    };

export type DuplicateView = {
  linkId: string;
  ticketId: string;
  subject: string | null;
  channelType: Enums<"channel_type"> | null;
  receivedAt: string;
  score: number | null;
  matchReason: string | null;
  linkStatus: Enums<"duplicate_link_status">;
  isPrimary: boolean;
};

export type OrderEventView = {
  id: string;
  kind: string;
  orderNumber: string | null;
  summary: string;
  occurredAt: string;
};

export type OtherTicketView = {
  id: string;
  subject: string | null;
  body: string | null;
  status: Enums<"ticket_status">;
  receivedAt: string;
  channelType: Enums<"channel_type"> | null;
};

export type Member = { userId: string; email: string; role: Enums<"tenant_role"> };

export type SavedReply = Pick<Tables<"saved_replies">, "id" | "title" | "body" | "updated_at">;

export type TicketDetail = TicketListItem & {
  channelId: string | null;
  channelStatus: Enums<"channel_status"> | null;
  externalId: string | null;
  externalThreadId: string | null;
  /** The customer's latest message on this ticket's channel, to reply to. */
  replyToMessageId: string | null;
  customerPhone: string | null;
  closedAt: string | null;
  mergedIntoTicketId: string | null;
  classificationError: string | null;
  timeline: TimelineEntry[];
  duplicates: DuplicateView[];
  orderHistory: OrderEventView[];
  otherTickets: OtherTicketView[];
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
    source: row.source === "agent" ? "agent" : "claude",
    classifiedAt: row.created_at,
  };
}

/** The live classification for a set of tickets, keyed by ticket id. */
async function liveClassifications(
  supabase: Supabase,
  ticketIds: string[],
): Promise<Map<string, ClassificationView>> {
  if (!ticketIds.length) {
    return new Map();
  }

  const { data } = await supabase
    .from("ticket_classifications")
    .select("*")
    .is("superseded_at", null)
    .in("ticket_id", ticketIds);

  return new Map((data ?? []).map((row) => [row.ticket_id, toClassification(row)]));
}

/** How many other tickets each of these is linked to, keyed by ticket id. */
async function duplicateCounts(
  supabase: Supabase,
  ticketIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ticketIds.length) {
    return counts;
  }

  // A pair is stored once, on whichever side each ticket happens to sit, so
  // both columns have to be asked. Only suggestions nobody has looked at yet
  // are news on the list; a confirmed or rejected pair has been dealt with.
  const [asPrimary, asDuplicate] = await Promise.all([
    supabase
      .from("duplicate_links")
      .select("primary_ticket_id")
      .eq("status", "suggested")
      .in("primary_ticket_id", ticketIds),
    supabase
      .from("duplicate_links")
      .select("duplicate_ticket_id")
      .eq("status", "suggested")
      .in("duplicate_ticket_id", ticketIds),
  ]);

  for (const row of asPrimary.data ?? []) {
    counts.set(row.primary_ticket_id, (counts.get(row.primary_ticket_id) ?? 0) + 1);
  }
  for (const row of asDuplicate.data ?? []) {
    counts.set(row.duplicate_ticket_id, (counts.get(row.duplicate_ticket_id) ?? 0) + 1);
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

/** Tickets with a reply that was claimed for sending and never finished. */
async function ticketsWithStuckSends(supabase: Supabase): Promise<string[]> {
  const cutoff = new Date(Date.now() - SEND_TIMEOUT_MS).toISOString();
  const { data } = await supabase
    .from("ticket_replies")
    .select("ticket_id")
    .eq("status", "sending")
    .lt("sending_started_at", cutoff)
    .limit(200);
  return [...new Set((data ?? []).map((row) => row.ticket_id))];
}

const LIST_FIELDS =
  "id, subject, body, status, customer_name, customer_email, order_number, received_at, last_message_at, assigned_to, classification_status, channel_id, channels(type, display_name)";

/**
 * One page of the queue.
 *
 * A search looks across every pile, because whoever is searching for a
 * customer does not know which pile their ticket is in. Everything else
 * narrows the pile being looked at.
 */
export async function listTickets(
  filters: TicketFilters,
  viewerId: string,
): Promise<{ items: TicketListItem[]; total: number }> {
  const supabase = await createClient();

  let query = supabase
    .from("tickets")
    .select(LIST_FIELDS, { count: "exact" })
    .is("merged_into_ticket_id", null);

  if (filters.q) {
    const like = `%${filters.q}%`;
    query = query.or(
      [
        `subject.ilike.${like}`,
        `customer_name.ilike.${like}`,
        `customer_email.ilike.${like}`,
        `customer_phone.ilike.${like}`,
        `order_number.ilike.${like}`,
      ].join(","),
    );
  } else if (filters.sorting === "failed") {
    query = query.eq("classification_status", "failed").neq("status", "closed");
  } else if (filters.stuck) {
    const ids = await ticketsWithStuckSends(supabase);
    query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  } else {
    query = query.eq("status", filters.status);
  }

  if (filters.category) {
    query = query.eq("category", filters.category);
  }
  if (filters.channelId) {
    query = query.eq("channel_id", filters.channelId);
  }
  if (filters.mine) {
    query = query.eq("assigned_to", viewerId);
  }

  const order = filters.q
    ? { column: "last_message_at" as const, ascending: false }
    : queueOrder(filters.status);

  const from = (filters.page - 1) * PAGE_SIZE;
  const { data: tickets, count } = await query
    .order(order.column, { ascending: order.ascending, nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  const rows = tickets ?? [];
  const ids = rows.map((row) => row.id);
  const [classifications, duplicates] = await Promise.all([
    liveClassifications(supabase, ids),
    duplicateCounts(supabase, ids),
  ]);

  return {
    total: count ?? rows.length,
    items: rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      body: row.body,
      status: row.status,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      orderNumber: row.order_number,
      receivedAt: row.received_at,
      lastMessageAt: row.last_message_at,
      assignedTo: row.assigned_to,
      classificationStatus: row.classification_status,
      channelType: row.channels?.type ?? null,
      channelName: row.channels?.display_name ?? null,
      classification: classifications.get(row.id) ?? null,
      duplicateCount: duplicates.get(row.id) ?? 0,
    })),
  };
}

/**
 * The ticket to open after finishing one: the top of the same pile, skipping
 * the one just finished and anything a colleague has taken. Falls back to
 * the other pile that needs a reply, so an empty pending pile leads on to
 * unopened work rather than to a list.
 */
export async function nextTicketId(
  pile: Enums<"ticket_status">,
  finishedId: string,
  viewerId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const piles: Enums<"ticket_status">[] =
    pile === "pending"
      ? ["pending", "unopened"]
      : pile === "unopened"
        ? ["unopened", "pending"]
        : [];

  for (const status of piles) {
    const order = queueOrder(status);
    const { data } = await supabase
      .from("tickets")
      .select("id")
      .eq("status", status)
      .is("merged_into_ticket_id", null)
      .neq("id", finishedId)
      .or(`assigned_to.is.null,assigned_to.eq.${viewerId}`)
      .order(order.column, { ascending: order.ascending, nullsFirst: false })
      .limit(1);
    if (data?.[0]) {
      return data[0].id;
    }
  }
  return null;
}

/**
 * The conversation on a ticket, oldest first: every customer message,
 * including those on tickets merged into it, and every reply that went out.
 *
 * A ticket from before conversations had their own table has no message
 * rows, so its own body stands in as the first message.
 */
export async function loadTimeline(
  supabase: Supabase,
  ticket: {
    id: string;
    subject: string | null;
    body: string | null;
    customer_name: string | null;
    customer_email: string | null;
    received_at: string;
    external_id: string | null;
  },
): Promise<{ timeline: TimelineEntry[]; mergedIds: string[] }> {
  const { data: merged } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, customer_name, customer_email, received_at, external_id",
    )
    .eq("merged_into_ticket_id", ticket.id)
    .limit(50);

  const all = [ticket, ...(merged ?? [])];
  const ids = all.map((row) => row.id);

  const [{ data: messages }, { data: replies }] = await Promise.all([
    supabase
      .from("ticket_messages")
      .select("id, ticket_id, sender_name, sender_email, subject, body, received_at")
      .in("ticket_id", ids)
      .order("received_at", { ascending: true })
      .limit(500),
    supabase
      .from("ticket_replies")
      .select("id, body, author, edited_by_agent, sent_at, send_note")
      .in("ticket_id", ids)
      .eq("status", "sent")
      .order("sent_at", { ascending: true }),
  ]);

  const withMessages = new Set((messages ?? []).map((row) => row.ticket_id));
  const entries: TimelineEntry[] = (messages ?? []).map((row) => ({
    kind: "customer",
    id: row.id,
    at: row.received_at,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    subject: row.subject,
    body: row.body,
    fromMergedTicket: row.ticket_id !== ticket.id,
  }));

  for (const row of all) {
    if (!withMessages.has(row.id)) {
      entries.push({
        kind: "customer",
        id: `ticket:${row.id}`,
        at: row.received_at,
        senderName: row.customer_name,
        senderEmail: row.customer_email,
        subject: row.subject,
        body: row.body,
        fromMergedTicket: row.id !== ticket.id,
      });
    }
  }

  for (const reply of replies ?? []) {
    entries.push({
      kind: "reply",
      id: reply.id,
      at: reply.sent_at ?? "",
      body: reply.body,
      author: reply.author,
      editedByAgent: reply.edited_by_agent,
      sendNote: reply.send_note,
    });
  }

  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { timeline: entries, mergedIds: (merged ?? []).map((row) => row.id) };
}

/**
 * What a reply answers: the customer's latest message that arrived on this
 * ticket's own channel. A message merged in from another channel cannot be
 * replied to from this mailbox.
 */
export async function replyTarget(
  supabase: Supabase,
  ticket: { id: string; channel_id: string | null; external_id: string | null },
): Promise<string | null> {
  if (!ticket.channel_id) {
    return null;
  }
  const { data } = await supabase
    .from("ticket_messages")
    .select("external_id")
    .eq("ticket_id", ticket.id)
    .eq("channel_id", ticket.channel_id)
    .not("external_id", "is", null)
    .order("received_at", { ascending: false })
    .limit(1);
  return data?.[0]?.external_id ?? ticket.external_id;
}

export async function listMembers(): Promise<Member[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("workspace_members");
  return (data ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
  }));
}

export async function listSavedReplies(): Promise<SavedReply[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("saved_replies")
    .select("id, title, body, updated_at")
    .order("title", { ascending: true })
    .limit(200);
  return data ?? [];
}

export async function getTicket(id: string): Promise<TicketDetail | null> {
  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, status, customer_name, customer_email, customer_phone, order_number, received_at, last_message_at, closed_at, assigned_to, classification_status, classification_error, merged_into_ticket_id, order_key, email_key, phone_key, external_id, external_thread_id, channel_id, channels(type, status, display_name)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!ticket) {
    return null;
  }

  const [classifications, links, replies, { timeline }, replyToMessageId] =
    await Promise.all([
      liveClassifications(supabase, [ticket.id]),
      supabase
        .from("duplicate_links")
        .select("id, primary_ticket_id, duplicate_ticket_id, score, match_reason, status")
        .neq("status", "rejected")
        .or(`primary_ticket_id.eq.${ticket.id},duplicate_ticket_id.eq.${ticket.id}`),
      supabase
        .from("ticket_replies")
        .select("*")
        .eq("ticket_id", ticket.id)
        .order("created_at", { ascending: true }),
      loadTimeline(supabase, ticket),
      replyTarget(supabase, ticket),
    ]);

  const otherIds = (links.data ?? []).map((link) =>
    link.primary_ticket_id === ticket.id ? link.duplicate_ticket_id : link.primary_ticket_id,
  );

  const [{ data: linked }, orderHistory, otherTickets] = await Promise.all([
    otherIds.length
      ? supabase
          .from("tickets")
          .select("id, subject, received_at, merged_into_ticket_id, channels(type)")
          .in("id", otherIds)
      : Promise.resolve({ data: [] as never[] }),
    loadOrderHistory(supabase, ticket.order_key, ticket.email_key),
    loadOtherTickets(supabase, ticket.id, ticket.email_key, ticket.phone_key),
  ]);

  const linkedById = new Map((linked ?? []).map((row) => [row.id, row]));

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
    lastMessageAt: ticket.last_message_at,
    closedAt: ticket.closed_at,
    assignedTo: ticket.assigned_to,
    classificationStatus: ticket.classification_status,
    classificationError: ticket.classification_error,
    mergedIntoTicketId: ticket.merged_into_ticket_id,
    externalId: ticket.external_id,
    externalThreadId: ticket.external_thread_id,
    replyToMessageId,
    channelId: ticket.channel_id,
    channelType: ticket.channels?.type ?? null,
    channelStatus: ticket.channels?.status ?? null,
    channelName: ticket.channels?.display_name ?? null,
    classification: classifications.get(ticket.id) ?? null,
    duplicateCount: otherIds.length,
    duplicates: (links.data ?? []).flatMap((link) => {
      const otherId =
        link.primary_ticket_id === ticket.id ? link.duplicate_ticket_id : link.primary_ticket_id;
      const other = linkedById.get(otherId);
      // A ticket already merged away has nothing left to decide.
      if (!other || other.merged_into_ticket_id) {
        return [];
      }
      return [
        {
          linkId: link.id,
          ticketId: otherId,
          subject: other.subject,
          channelType: other.channels?.type ?? null,
          receivedAt: other.received_at,
          score: link.score === null ? null : Number(link.score),
          matchReason: link.match_reason,
          linkStatus: link.status,
          isPrimary: link.primary_ticket_id === otherId,
        },
      ];
    }),
    orderHistory,
    otherTickets,
    timeline,
    replies: replies.data ?? [],
  };
}

/** Cancellations and refunds on this order or for this customer. */
async function loadOrderHistory(
  supabase: Supabase,
  orderKey: string | null,
  emailKey: string | null,
): Promise<OrderEventView[]> {
  const found = new Map<string, OrderEventView>();
  for (const [column, value] of [
    ["order_key", orderKey],
    ["email_key", emailKey],
  ] as const) {
    if (!value) continue;
    const { data } = await supabase
      .from("order_events")
      .select("id, kind, order_number, summary, occurred_at")
      .eq(column, value)
      .order("occurred_at", { ascending: false })
      .limit(20);
    for (const row of data ?? []) {
      found.set(row.id, {
        id: row.id,
        kind: row.kind,
        orderNumber: row.order_number,
        summary: row.summary,
        occurredAt: row.occurred_at,
      });
    }
  }
  return [...found.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

/** The same customer's other tickets, by email address or phone number. */
async function loadOtherTickets(
  supabase: Supabase,
  ticketId: string,
  emailKey: string | null,
  phoneKey: string | null,
): Promise<OtherTicketView[]> {
  const found = new Map<string, OtherTicketView>();
  for (const [column, value] of [
    ["email_key", emailKey],
    ["phone_key", phoneKey],
  ] as const) {
    if (!value) continue;
    const { data } = await supabase
      .from("tickets")
      .select("id, subject, body, status, received_at, channels(type)")
      .eq(column, value)
      .neq("id", ticketId)
      .is("merged_into_ticket_id", null)
      .order("received_at", { ascending: false })
      .limit(10);
    for (const row of data ?? []) {
      found.set(row.id, {
        id: row.id,
        subject: row.subject,
        body: row.body,
        status: row.status,
        receivedAt: row.received_at,
        channelType: row.channels?.type ?? null,
      });
    }
  }
  return [...found.values()]
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    .slice(0, 10);
}
