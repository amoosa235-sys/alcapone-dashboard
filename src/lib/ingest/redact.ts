import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * Erasing one customer from a workspace, for Shopify's customers/redact.
 *
 * A customer's words and details are not only on the ticket. They are copied
 * into each message of the conversation, into what Claude read out of it,
 * into the replies written back, and into the store's order history. Erasing
 * the ticket alone would leave all of that behind, so this walks every place.
 *
 * It is scoped to the workspace, not the store, because the same person
 * emailing about the same order is the same person. Matching is on the exact
 * address, never a pattern, so nobody else's ticket is touched. Phone numbers
 * are not used: two people can share the last digits the matcher compares.
 */

type Admin = ReturnType<typeof createAdminClient>;

const REDACTED = "[redacted at the customer's request]";

export type RedactionRequest = {
  tenantId: string;
  email: string | null;
  /** Shopify order ids, which the tickets carry as their thread. */
  orderIds: number[];
};

export type RedactionResult = { tickets: number; orderEvents: number; error: string | null };

export async function redactCustomer(
  admin: Admin,
  request: RedactionRequest,
): Promise<RedactionResult> {
  const email = request.email?.trim().toLowerCase() || null;
  const threads = request.orderIds.map((id) => `order:${id}`);

  if (!email && !threads.length) {
    return { tickets: 0, orderEvents: 0, error: null };
  }

  const ticketIds = new Set<string>();
  if (email) {
    const { data, error } = await admin
      .from("tickets")
      .select("id")
      .eq("tenant_id", request.tenantId)
      .eq("email_key", email);
    if (error) {
      return { tickets: 0, orderEvents: 0, error: error.message };
    }
    for (const row of data ?? []) ticketIds.add(row.id);
  }
  if (threads.length) {
    const { data, error } = await admin
      .from("tickets")
      .select("id")
      .eq("tenant_id", request.tenantId)
      .in("external_thread_id", threads);
    if (error) {
      return { tickets: 0, orderEvents: 0, error: error.message };
    }
    for (const row of data ?? []) ticketIds.add(row.id);
  }

  const ids = [...ticketIds];
  const failures: string[] = [];
  const note = (error: { message: string } | null) => {
    if (error) failures.push(error.message);
  };

  if (ids.length) {
    note(
      (
        await admin
          .from("tickets")
          .update({
            customer_name: null,
            customer_email: null,
            customer_phone: null,
            body: REDACTED,
            raw: {},
          })
          .eq("tenant_id", request.tenantId)
          .in("id", ids)
      ).error,
    );
    note(
      (
        await admin
          .from("ticket_messages")
          .update({ sender_name: null, sender_email: null, body: REDACTED, raw: {} })
          .eq("tenant_id", request.tenantId)
          .in("ticket_id", ids)
      ).error,
    );
    note(
      (
        await admin
          .from("ticket_classifications")
          .update({
            customer_name: null,
            contact_number: null,
            summary: null,
            item_needing_attention: null,
            ordered_items: [],
            raw_response: null,
          })
          .eq("tenant_id", request.tenantId)
          .in("ticket_id", ids)
      ).error,
    );
    // A reply is addressed to the customer and usually names them.
    note(
      (
        await admin
          .from("ticket_replies")
          .update({ body: REDACTED })
          .eq("tenant_id", request.tenantId)
          .in("ticket_id", ids)
      ).error,
    );
  }

  let orderEvents = 0;
  if (email) {
    const { data, error } = await admin
      .from("order_events")
      .update({
        customer_name: null,
        customer_email: null,
        customer_phone: null,
        summary: REDACTED,
        raw: {},
      })
      .eq("tenant_id", request.tenantId)
      .eq("email_key", email)
      .select("id");
    note(error);
    orderEvents = data?.length ?? 0;
  }

  return {
    tickets: ids.length,
    orderEvents,
    error: failures.length ? failures.join("; ") : null,
  };
}
