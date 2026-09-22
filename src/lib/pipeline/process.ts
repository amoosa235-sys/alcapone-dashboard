import { classifyTicket } from "@/lib/classify";
import { afterClassification } from "@/lib/classify/retry";
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
 * Where classification stands is kept on the ticket itself, so the job can
 * find what is still waiting with one indexed query, back off after a
 * failure, and stop after a few, instead of retrying a hopeless ticket
 * forever at the front of the queue.
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
      "id, tenant_id, subject, body, customer_name, customer_email, customer_phone, order_number, classification_attempts, channels(type)",
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
    await admin
      .from("tickets")
      .update(
        afterClassification(ticket.classification_attempts, {
          ok: false,
          error: classification.error,
          retryable: classification.retryable,
        }),
      )
      .eq("id", ticket.id)
      .eq("tenant_id", tenantId);
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
        source: "claude",
      });

    if (insertError) {
      result.classificationError = insertError.message;
      await admin
        .from("tickets")
        .update(
          afterClassification(ticket.classification_attempts, {
            ok: false,
            error: insertError.message,
            retryable: true,
          }),
        )
        .eq("id", ticket.id)
        .eq("tenant_id", tenantId);
    } else {
      result.classified = true;
      result.category = verdict.category;

      // Only fill gaps. What the channel knew is first-hand; what was read
      // out of the message text is not, and must not overwrite it.
      const update: TablesUpdate<"tickets"> = {
        category: verdict.category,
        ...afterClassification(ticket.classification_attempts, { ok: true }),
      };
      if (!ticket.order_number && verdict.order_number) {
        update.order_number = verdict.order_number;
      }
      if (!ticket.customer_name && verdict.customer_name) {
        update.customer_name = verdict.customer_name;
      }
      if (!ticket.customer_phone && verdict.contact_number) {
        update.customer_phone = verdict.contact_number;
      }

      await admin
        .from("tickets")
        .update(update)
        .eq("id", ticket.id)
        .eq("tenant_id", tenantId);
    }
  }

  const linked = await linkDuplicates(admin, tenantId, ticket.id);
  result.duplicatesLinked = linked.length;
  result.duplicateReasons = linked;

  return result;
}

const CANDIDATE_FIELDS =
  "id, channel_id, external_thread_id, order_number, customer_email, customer_phone, category, received_at, order_key, email_key, phone_key, merged_into_ticket_id, channels(type)";

type CandidateRow = {
  id: string;
  channel_id: string | null;
  external_thread_id: string | null;
  order_number: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  category: string | null;
  received_at: string;
  order_key: string | null;
  email_key: string | null;
  phone_key: string | null;
  merged_into_ticket_id: string | null;
  channels: { type: string } | null;
};

function toCandidate(row: CandidateRow): DuplicateCandidate {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelType: row.channels?.type ?? null,
    externalThreadId: row.external_thread_id,
    orderNumber: row.order_number,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    category: row.category,
    receivedAt: row.received_at,
  };
}

/**
 * Looks for the same issue elsewhere and records any pair worth showing.
 *
 * Only tickets sharing an order number, an email address or a phone number
 * can match, so those are the only ones read, each through its own index,
 * rather than every ticket from the last fortnight. Returns the reasons for
 * the links this ticket now has.
 */
export async function linkDuplicates(
  admin: Admin,
  tenantId: string,
  ticketId: string,
): Promise<string[]> {
  const { data: subjectRow } = await admin
    .from("tickets")
    .select(CANDIDATE_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("id", ticketId)
    .maybeSingle();

  if (!subjectRow || subjectRow.merged_into_ticket_id) {
    return [];
  }

  const since = new Date(
    Date.parse(subjectRow.received_at) - MATCH_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const until = new Date(
    Date.parse(subjectRow.received_at) + MATCH_WINDOW_DAYS * 86_400_000,
  ).toISOString();

  const keys = [
    ["order_key", subjectRow.order_key],
    ["email_key", subjectRow.email_key],
    ["phone_key", subjectRow.phone_key],
  ] as const;

  const found = new Map<string, CandidateRow>();
  for (const [column, value] of keys) {
    if (!value) {
      continue;
    }
    const { data } = await admin
      .from("tickets")
      .select(CANDIDATE_FIELDS)
      .eq("tenant_id", tenantId)
      .eq(column, value)
      .neq("id", ticketId)
      .is("merged_into_ticket_id", null)
      .gte("received_at", since)
      .lte("received_at", until)
      .limit(50);
    for (const row of (data ?? []) as CandidateRow[]) {
      found.set(row.id, row);
    }
  }

  if (found.size) {
    const { count: shopifyStores } = await admin
      .from("channels")
      .select("id", { head: true, count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("type", "shopify");

    const subject = toCandidate(subjectRow as CandidateRow);
    const candidates = [...found.values()].map(toCandidate);

    for (const link of findDuplicates(subject, candidates, {
      shopifyStores: shopifyStores ?? 0,
    })) {
      const { error } = await admin.from("duplicate_links").insert({
        tenant_id: tenantId,
        primary_ticket_id: link.primaryTicketId,
        duplicate_ticket_id: link.duplicateTicketId,
        score: link.score,
        match_reason: link.matchReason,
        detected_by: "rule",
      });

      // 23505 is the unique index on the ordered pair: this pair is already
      // recorded, whether suggested or already reviewed by a person.
      if (error && error.code !== "23505") {
        console.error("duplicates: could not link", {
          code: error.code,
          message: error.message,
        });
      }
    }
  }

  const { data: links } = await admin
    .from("duplicate_links")
    .select("match_reason")
    .eq("tenant_id", tenantId)
    .neq("status", "rejected")
    .or(`primary_ticket_id.eq.${ticketId},duplicate_ticket_id.eq.${ticketId}`);

  return (links ?? []).map((row) => row.match_reason ?? "matched");
}
