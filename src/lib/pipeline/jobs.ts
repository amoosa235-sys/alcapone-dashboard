import { syncMailbox, type MailboxSyncResult } from "@/lib/outlook/sync";
import { processTicket, type ProcessResult } from "@/lib/pipeline/process";
import { reconcileStore, type ReconcileResult } from "@/lib/shopify/reconcile";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The recurring work, for one workspace: read every mailbox, catch up on any
 * Shopify webhooks that went missing, then classify whatever is waiting.
 *
 * Everything takes a deadline and stops starting new work once it has
 * passed, so a busy workspace cannot run the whole job past its time limit
 * and leave the next one with nothing. Anything unfinished is picked up by
 * the next run. All of it is safe to run twice.
 */

export async function syncAllMailboxes(
  admin: Admin,
  tenantId: string,
  deadline: number,
): Promise<MailboxSyncResult[]> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, tenant_id, external_account_id, config, last_synced_at, created_at")
    .eq("tenant_id", tenantId)
    .eq("type", "outlook")
    .in("status", ["connected", "pending", "error"]);

  const results: MailboxSyncResult[] = [];
  for (const channel of channels ?? []) {
    if (Date.now() > deadline) {
      break;
    }
    results.push(await syncMailbox(admin, channel, deadline));
  }
  return results;
}

export async function reconcileAllStores(
  admin: Admin,
  tenantId: string,
  origin: string,
  deadline: number,
): Promise<ReconcileResult[]> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, tenant_id, external_account_id, config")
    .eq("tenant_id", tenantId)
    .eq("type", "shopify")
    .in("status", ["connected", "error"]);

  const results: ReconcileResult[] = [];
  for (const channel of channels ?? []) {
    if (Date.now() > deadline) {
      break;
    }
    results.push(await reconcileStore(admin, channel, origin, deadline));
  }
  return results;
}

/**
 * Tickets still waiting for Claude whose retry time has come, oldest first.
 * A ticket that failed and is waiting to be retried is skipped until then,
 * and one that has given up is not in this list at all.
 */
export async function classifyOutstanding(
  admin: Admin,
  tenantId: string,
  deadline: number,
  limit = 25,
): Promise<ProcessResult[]> {
  const now = new Date().toISOString();
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("classification_status", "pending")
    .or(`classification_retry_at.is.null,classification_retry_at.lte.${now}`)
    .order("received_at", { ascending: true })
    .limit(limit);

  const results: ProcessResult[] = [];
  for (const ticket of tickets ?? []) {
    if (Date.now() > deadline) {
      break;
    }
    results.push(await processTicket(admin, tenantId, ticket.id));
  }
  return results;
}

export type TenantJobReport = {
  mailboxes: MailboxSyncResult[];
  stores: ReconcileResult[];
  classified: ProcessResult[];
};

export async function runTenantJobs(
  admin: Admin,
  tenantId: string,
  options: { origin: string; deadline: number },
): Promise<TenantJobReport> {
  const mailboxes = await syncAllMailboxes(admin, tenantId, options.deadline);
  const stores = await reconcileAllStores(
    admin,
    tenantId,
    options.origin,
    options.deadline,
  );
  const classified = await classifyOutstanding(admin, tenantId, options.deadline);

  const report: TenantJobReport = { mailboxes, stores, classified };

  await admin.from("job_heartbeats").upsert(
    {
      tenant_id: tenantId,
      last_run_at: new Date().toISOString(),
      report: summarise(report) as Json,
    },
    { onConflict: "tenant_id" },
  );

  return report;
}

/** What the heartbeat keeps: counts and errors, never message content. */
export function summarise(report: TenantJobReport) {
  return {
    mailboxes: report.mailboxes.map((entry) => ({
      mailbox: entry.mailbox,
      created: entry.created,
      appended: entry.appended,
      skipped: entry.skipped,
      caughtUp: entry.caughtUp,
      error: entry.error,
    })),
    stores: report.stores.map((entry) => ({
      shop: entry.shop,
      skipped: entry.skipped,
      ordersChecked: entry.ordersChecked,
      ticketsCreated: entry.ticketsCreated,
      eventsRecorded: entry.eventsRecorded,
      webhooksRepaired: entry.webhooksRepaired,
      error: entry.error,
    })),
    classified: report.classified.filter((entry) => entry.classified).length,
    classificationErrors: report.classified
      .map((entry) => entry.classificationError)
      .filter(Boolean),
  };
}
