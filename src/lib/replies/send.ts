import { GRAPH_ROOT, fetchGraphToken } from "@/lib/outlook/graph";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Enums } from "@/types/database";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Putting a reply back down the channel it arrived on.
 *
 * Only ever called by the send action, which is a separate press from the one
 * that wrote the words. Nothing in the drafting path can reach this.
 *
 * A channel that cannot carry a reply yet says so in a sentence an agent can
 * act on, rather than failing at the moment they press send. `sendBlockedOn`
 * is the same question asked ahead of time, so the button can be disabled
 * with that reason showing.
 */

export type SendOutcome =
  | { ok: true; externalMessageId: string | null }
  | { ok: false; error: string };

/**
 * Why this ticket cannot be replied to, or null when it can.
 *
 * Pure, so the page and the action agree without either asking the other.
 */
export function sendBlockedOn(ticket: {
  channelType: Enums<"channel_type"> | null;
  channelStatus: Enums<"channel_status"> | null;
  externalId: string | null;
  customerEmail: string | null;
}): string | null {
  if (!ticket.channelType) {
    return "This ticket is not attached to a channel any more, so there is nowhere to send a reply.";
  }

  if (ticket.channelType !== "outlook") {
    return `Replies cannot go out over ${ticket.channelType} yet. Email is the only channel that can send, so this draft is yours to copy for now.`;
  }

  if (!ticket.externalId) {
    return "The original email is not on file, so there is no conversation to reply into.";
  }

  if (ticket.channelStatus !== "connected") {
    return "That mailbox is not connected. Add its app registration on the Channels page and run the check.";
  }

  return null;
}

/**
 * Replies in the original email thread, as the mailbox the message arrived in.
 *
 * Graph's reply endpoint puts the comment above the quoted original and sends
 * it, which is what a customer expects to receive. It answers 202 with no
 * body, so there is no message id to record; the sent row carries who sent it
 * and when, which is what the audit actually needs.
 *
 * This needs Mail.Send as an application permission on the same app
 * registration that already holds Mail.Read. Without it Graph answers 403,
 * and that is surfaced as it comes rather than flattened.
 */
export async function sendOutlookReply(
  admin: Admin,
  channel: { id: string; external_account_id: string | null; config: unknown },
  messageId: string,
  body: string,
): Promise<SendOutcome> {
  const mailbox = channel.external_account_id ?? "";
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
    return {
      ok: false,
      error:
        "That mailbox is missing part of its app registration. Re-enter it on the Channels page.",
    };
  }

  let token: string;
  try {
    token = await fetchGraphToken({ tenantId, clientId, clientSecret });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Microsoft refused the sign-in.",
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${GRAPH_ROOT}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment: body }),
      },
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach Microsoft.",
    };
  }

  if (response.status === 403) {
    return {
      ok: false,
      error:
        "Microsoft allowed the sign-in but not the send. The app registration needs Mail.Send as an application permission, granted by an administrator.",
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: `Microsoft would not send it (${response.status}): ${detail.slice(0, 200)}`,
    };
  }

  return { ok: true, externalMessageId: null };
}
