import { classifyTicket } from "@/lib/classify";
import {
  MATCH_WINDOW_DAYS,
  findDuplicates,
  type DuplicateCandidate,
} from "@/lib/duplicates/detect";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/types/database";

/**
 * What happens to a ticket once it exists, whichever channel it arrived on.
 *
 * Classify, write what was extracted back onto the ticket where the channel
 * did not already know it, then look for the same issue arriving elsewhere.
 * Duplicate detection runs last on purpose: an email has no order number
 * until classification finds one in the text.
 *
 * This runs after the response has been sent, so a failure here must never
 * throw into the caller. Every step reports instead.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type ProcessResult = {
  ticketId: string;
  classified: boolean;
  category: string | null;
  classificationError: string | null;
  duplicatesLinked: number;
  duplicateReasons: string[];
};

export async function processTicket(
  admin: Admin,
  tenantId: string,
  ticketId: string,
): Promise<ProcessResult> {
  const result: ProcessResult = {
    ticketId,
    classified: false,
    category: null,
    classificationError: null,
    duplicatesLinked: 0,
    duplicateReasons: [],
  };

  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .select(
      "id, tenant_id, channel_id, external_thread_id, subject, body, customer_name, customer_email, customer_phone, order_number, received_at, channels(type)",
    )
    .eq("id", ticketId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (ticketError || !ticket) {
    result.classificationError =
      ticketError?.message ?? "That ticket no longer exists.";
    return result;
  }

  const channelType = ticket.channels?.type ?? "unknown";

  const classification = await classifyTicket({
    subject: ticket.subject,
    body: ticket.body,
    channel: channelType,
    known: {
      customerName: ticket.customer_name,
      customerEmail: ticket.customer_email,
      customerPhone: ticket.customer_phone,
      orderNumber: ticket.order_number,
    },
  });

  if (!classification.ok) {
    result.classificationError = classification.error;
    // Duplicate detection still runs: a Shopify ticket already carries an
    // order number, so a match can be found without Claude.
  } else {
    const verdict = classification.classification;

    // One current classification per ticket. The old one is kept as history.
    await admin
      .from("ticket_classifications")
      .update({ superseded_at: new Date().toISOString() })
      .eq("ticket_id", ticket.id)
      .eq("tenant_id", tenantId)
      .is("superseded_at", null);

    const { error: insertError } = await admin
      .from("ticket_classifications")
      .insert({
        tenant_id: tenantId,
        ticket_id: ticket.id,
        category: verdict.category,
        confidence: verdict.confidence,
        summary: verdict.summary,
        customer_name: verdict.customer_name,
        contact_number: verdict.contact_number,
        order_number: verdict.order_number,
        ordered_items: verdict.ordered_items as unknown as Json,
        item_needing_attention: verdict.item_needing_attention,
        model: classification.model,
        prompt_version: classification.promptVersion,
      });

    if (insertError) {
      result.classificationError = insertError.message;
    } else {
      result.classified = true;
      result.category = verdict.category;

      // Only fill gaps. What the channel knew is first-hand; what was read
      // out of the message text is not, and must not overwrite it.
      const backfill: TablesUpdate<"tickets"> = {};
      if (!ticket.order_number && verdict.order_number) {
        backfill.order_number = verdict.order_number;
      }
      if (!ticket.customer_name && verdict.customer_name) {
        backfill.customer_name = verdict.customer_name;
      }
      if (!ticket.customer_phone && verdict.contact_number) {
        backfill.customer_phone = verdict.contact_number;
      }

      if (Object.keys(backfill).length) {
        await admin
          .from("tickets")
          .update(backfill)
          .eq("id", ticket.id)
          .eq("tenant_id", tenantId);
        Object.assign(ticket, backfill);
      }
    }
  }

  await linkDuplicates(admin, tenantId, ticket.id);
  const linked = await countLinks(admin, tenantId, ticket.id);
  result.duplicatesLinked = linked.count;
  result.duplicateReasons = linked.reasons;

  return result;
}

/** The live classification category for a set of tickets. */
async function categoriesFor(
  admin: Admin,
  tenantId: string,
  ticketIds: string[],
): Promise<Map<string, string>> {
  if (!ticketIds.length) {
    return new Map();
  }
  const { data } = await admin
    .from("ticket_classifications")
    .select("ticket_id, category")
    .eq("tenant_id", tenantId)
    .is("superseded_at", null)
    .in("ticket_id", ticketIds);

  return new Map((data ?? []).map((row) => [row.ticket_id, row.category]));
}

async function linkDuplicates(
  admin: Admin,
  tenantId: string,
  ticketId: string,
): Promise<void> {
  const since = new Date(
    Date.now() - MATCH_WINDOW_DAYS * 86_400_000,
  ).toISOString();

  const { data: rows } = await admin
    .from("tickets")
    .select(
      "id, channel_id, external_thread_id, order_number, customer_email, customer_phone, received_at, channels(type)",
    )
    .eq("tenant_id", tenantId)
    .gte("received_at", since)
    .is("merged_into_ticket_id", null);

  if (!rows?.length) {
    return;
  }

  const categories = await categoriesFor(
    admin,
    tenantId,
    rows.map((row) => row.id),
  );

  const candidates: DuplicateCandidate[] = rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    channelType: row.channels?.type ?? null,
    externalThreadId: row.external_thread_id,
    orderNumber: row.order_number,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    category: categories.get(row.id) ?? null,
    receivedAt: row.received_at,
  }));

  const subject = candidates.find((row) => row.id === ticketId);
  if (!subject) {
    return;
  }

  for (const link of findDuplicates(subject, candidates)) {
    const { error } = await admin.from("duplicate_links").insert({
      tenant_id: tenantId,
      primary_ticket_id: link.primaryTicketId,
      duplicate_ticket_id: link.duplicateTicketId,
      score: link.score,
      match_reason: link.matchReason,
      detected_by: "rule",
    });

    // 23505 is the unique index on the ordered pair: this pair is already
    // suggested, which is the point of the index.
    if (error && error.code !== "23505") {
      console.error("duplicates: could not link", {
        code: error.code,
        message: error.message,
      });
    }
  }
}

async function countLinks(
  admin: Admin,
  tenantId: string,
  ticketId: string,
): Promise<{ count: number; reasons: string[] }> {
  const { data } = await admin
    .from("duplicate_links")
    .select("match_reason, primary_ticket_id, duplicate_ticket_id")
    .eq("tenant_id", tenantId)
    .or(`primary_ticket_id.eq.${ticketId},duplicate_ticket_id.eq.${ticketId}`);

  return {
    count: data?.length ?? 0,
    reasons: (data ?? []).map((row) => row.match_reason ?? "matched"),
  };
}
