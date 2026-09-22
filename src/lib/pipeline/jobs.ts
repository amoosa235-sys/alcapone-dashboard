import { syncMailbox, type MailboxSyncResult } from "@/lib/outlook/sync";
import { processTicket, type ProcessResult } from "@/lib/pipeline/process";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The recurring work: check every connected mailbox, then classify anything
 * that arrived without being classified -- a webhook whose background work
 * was cut short, or a ticket that hit a rate limit the first time.
 *
 * Both are safe to run again. Nothing here throws; each part reports.
 */

export async function syncAllMailboxes(
  admin: Admin,
  tenantId: string,
): Promise<MailboxSyncResult[]> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, tenant_id, external_account_id, config, last_synced_at")
    .eq("tenant_id", tenantId)
    .eq("type", "outlook")
    .in("status", ["connected", "pending", "error"]);

  const results: MailboxSyncResult[] = [];
  for (const channel of channels ?? []) {
    results.push(await syncMailbox(admin, channel));
  }
  return results;
}

/** Tickets with no live classification, oldest first. */
export async function classifyOutstanding(
  admin: Admin,
  tenantId: string,
  limit = 20,
): Promise<ProcessResult[]> {
  const { data: classified } = await admin
    .from("ticket_classifications")
    .select("ticket_id")
    .eq("tenant_id", tenantId)
    .is("superseded_at", null);

  const done = new Set((classified ?? []).map((row) => row.ticket_id));

  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("tenant_id", tenantId)
    .order("received_at", { ascending: true })
    .limit(500);

  const outstanding = (tickets ?? [])
    .filter((ticket) => !done.has(ticket.id))
    .slice(0, limit);

  const results: ProcessResult[] = [];
  for (const ticket of outstanding) {
    results.push(await processTicket(admin, tenantId, ticket.id));
  }
  return results;
}
