import { detectAutomated } from "./automated";
import { outlookToken } from "./credentials";
import { fetchMessagePage } from "./graph";
import { normalizeGraphMessage } from "./tickets";
import { ingestMessage } from "@/lib/ingest/messages";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

type Admin = ReturnType<typeof createAdminClient>;

export type MailboxSyncResult = {
  channelId: string;
  mailbox: string;
  fetched: number;
  created: number;
  appended: number;
  skipped: number;
  /** False when the run stopped with more mail still waiting. */
  caughtUp: boolean;
  error: string | null;
};

/** Pages read per mailbox per run, so one busy mailbox cannot starve the rest. */
export const MAX_PAGES_PER_RUN = 10;

/**
 * How far back the first check of a newly connected mailbox reaches. A
 * support inbox can hold years of mail, and every message in it would
 * otherwise become a ticket on the first run.
 */
export const FIRST_SYNC_LOOKBACK_HOURS = 24;

/**
 * Pulls whatever has arrived in one mailbox since the last run and files it:
 * a new conversation becomes a ticket, a reply on an existing one joins it,
 * and automatic mail is skipped.
 *
 * It reads page after page until it has caught up, the page budget runs
 * out, or the deadline passes. The cursor moves after every page, so a run
 * that is cut off keeps what it finished, and the next run carries on from
 * there. Classification is not done here; the job does it after every
 * mailbox has been read.
 */
export async function syncMailbox(
  admin: Admin,
  channel: {
    id: string;
    tenant_id: string;
    external_account_id: string | null;
    config: Json;
    last_synced_at: string | null;
    created_at: string;
  },
  deadline: number = Date.now() + 60_000,
): Promise<MailboxSyncResult> {
  const result: MailboxSyncResult = {
    channelId: channel.id,
    mailbox: channel.external_account_id ?? "",
    fetched: 0,
    created: 0,
    appended: 0,
    skipped: 0,
    caughtUp: false,
    error: null,
  };

  const auth = await outlookToken(admin, channel);
  if ("error" in auth) {
    result.error = auth.error;
    await markChannel(admin, channel, { status: "error", last_error: auth.error });
    return result;
  }

  const firstSyncFrom = new Date(
    Date.parse(channel.created_at) - FIRST_SYNC_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();
  let cursor = channel.last_synced_at ?? firstSyncFrom;
  let nextLink: string | null = null;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    if (Date.now() > deadline) {
      break;
    }

    let batch;
    try {
      batch = await fetchMessagePage(auth.token, auth.mailbox, cursor, nextLink);
    } catch (error) {
      result.error = error instanceof Error ? error.message : "Graph request failed.";
      await markChannel(admin, channel, { status: "error", last_error: result.error });
      return result;
    }

    result.fetched += batch.messages.length;

    for (const message of batch.messages) {
      const email = normalizeGraphMessage(message);
      if (!email) {
        continue;
      }

      const verdict = detectAutomated({
        headers: message.internetMessageHeaders,
        fromAddress: email.fromAddress,
        replyToAddress: message.replyTo?.[0]?.emailAddress?.address ?? null,
        mailbox: auth.mailbox,
        subject: email.subject,
      });

      if (verdict.automated) {
        result.skipped += 1;
      } else {
        const outcome = await ingestMessage(admin, {
          tenantId: channel.tenant_id,
          channelId: channel.id,
          externalId: email.externalId,
          threadId: email.externalThreadId,
          subject: email.subject,
          body: email.body,
          senderName: email.customerName,
          senderEmail: email.customerEmail,
          receivedAt: email.receivedAt,
          raw: message as unknown as Json,
        });

        if (outcome.outcome === "error") {
          // The cursor stays where the last finished page left it, so this
          // message is read again next time.
          result.error = outcome.error;
          await markChannel(admin, channel, {
            status: "error",
            last_error: outcome.error,
          });
          return result;
        }
        if (outcome.outcome === "created") {
          result.created += 1;
        } else if (outcome.outcome === "appended") {
          result.appended += 1;
        }
      }

      if (Date.parse(email.receivedAt) > Date.parse(cursor)) {
        cursor = email.receivedAt;
      }
    }

    // Everything up to here is in, so the next run can start from it.
    // last_synced_at is the cursor: the newest message taken, not when the
    // mailbox was last looked at, which is last_checked_at in config.
    await markChannel(admin, channel, {
      status: "connected",
      last_error: null,
      last_synced_at: cursor,
      config: {
        ...((channel.config ?? {}) as Record<string, Json>),
        last_checked_at: new Date().toISOString(),
      },
    });

    nextLink = batch.nextLink;
    if (!nextLink) {
      result.caughtUp = true;
      break;
    }
  }

  return result;
}

async function markChannel(
  admin: Admin,
  channel: { id: string; tenant_id: string },
  update: {
    status: "error" | "connected";
    last_error: string | null;
    last_synced_at?: string;
    config?: Json;
  },
): Promise<void> {
  await admin
    .from("channels")
    .update(update)
    .eq("id", channel.id)
    .eq("tenant_id", channel.tenant_id);
}
