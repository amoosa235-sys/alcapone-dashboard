"use server";

import { revalidatePath } from "next/cache";

import { getMembership, getUser } from "@/lib/auth";
import { draftReply } from "@/lib/replies/draft";
import { sendBlockedOn, sendOutlookReply } from "@/lib/replies/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canMove, type TicketStatus } from "@/lib/tickets/view";
import { TICKET_STATUSES } from "@/types/database";

/**
 * Everything an agent does to a ticket.
 *
 * A server action is reachable by anyone who can POST to it, not only through
 * the page, so each one re-checks who is asking. Reads go through the user's
 * own session so row level security decides what they can touch; the admin
 * client appears only where a mailbox credential has to be read, which the
 * browser must never be able to do.
 *
 * Drafting and sending are two separate actions on purpose. Nothing in the
 * drafting path can reach the send path, so there is no sequence of events
 * that puts words in front of a customer without a person having pressed
 * send.
 */

export type TicketActionState = {
  error: string | null;
  notice: string | null;
};

export const EMPTY_TICKET_STATE: TicketActionState = {
  error: null,
  notice: null,
};

type Caller = {
  userId: string;
  tenantId: string;
  tenantName: string;
};

async function caller(): Promise<Caller | { error: string }> {
  const user = await getUser();
  if (!user) {
    return { error: "Sign in again, your session has expired." };
  }

  const membership = await getMembership();
  if (!membership) {
    return { error: "You are not a member of a workspace." };
  }

  return {
    userId: user.id,
    tenantId: membership.tenantId,
    tenantName: membership.tenantName,
  };
}

function isTicketStatus(value: unknown): value is TicketStatus {
  return (
    typeof value === "string" &&
    (TICKET_STATUSES as readonly string[]).includes(value)
  );
}

function field(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

/**
 * Moves a ticket between unopened, pending and closed.
 *
 * The move is checked against the ticket as it stands rather than against
 * what the form claimed it was, so two agents on the same ticket cannot talk
 * each other into an impossible transition.
 */
export async function moveTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return { error: who.error, notice: null };
  }

  const ticketId = field(formData, "ticketId");
  const to = field(formData, "to");

  if (!ticketId || !isTicketStatus(to)) {
    return { error: "That is not a status I know about.", notice: null };
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, status")
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return { error: "That ticket is not yours to change.", notice: null };
  }

  if (ticket.status === to) {
    return { error: null, notice: null };
  }

  if (!canMove(ticket.status, to)) {
    return {
      error: `A ${ticket.status} ticket cannot go straight to ${to}.`,
      notice: null,
    };
  }

  const { error } = await supabase
    .from("tickets")
    .update({
      status: to,
      closed_at: to === "closed" ? new Date().toISOString() : null,
    })
    .eq("id", ticketId);

  if (error) {
    console.error("tickets: could not move", {
      code: error.code,
      message: error.message,
    });
    return { error: "Could not change that. Try again.", notice: null };
  }

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/");

  return { error: null, notice: null };
}

/**
 * Asks Claude for a draft and stores it as one. It is not sent, not queued,
 * and not shown to anybody outside the workspace; it is a row an agent can
 * rewrite or throw away.
 */
export async function requestDraft(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return { error: who.error, notice: null };
  }

  const ticketId = field(formData, "ticketId");
  if (!ticketId) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, customer_name, order_number, channels(type)",
    )
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  const { data: classification } = await supabase
    .from("ticket_classifications")
    .select("category, summary, item_needing_attention, ordered_items")
    .eq("ticket_id", ticketId)
    .is("superseded_at", null)
    .maybeSingle();

  const { data: sent } = await supabase
    .from("ticket_replies")
    .select("body")
    .eq("ticket_id", ticketId)
    .eq("status", "sent")
    .order("sent_at", { ascending: true });

  const orderedItems = Array.isArray(classification?.ordered_items)
    ? (classification.ordered_items as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const row = entry as Record<string, unknown>;
        return typeof row.name === "string"
          ? [
              {
                name: row.name,
                quantity: typeof row.quantity === "number" ? row.quantity : null,
              },
            ]
          : [];
      })
    : [];

  const result = await draftReply({
    workspaceName: who.tenantName,
    channel: ticket.channels?.type ?? "unknown",
    subject: ticket.subject,
    body: ticket.body,
    customerName: ticket.customer_name,
    orderNumber: ticket.order_number,
    category: classification?.category ?? null,
    summary: classification?.summary ?? null,
    itemNeedingAttention: classification?.item_needing_attention ?? null,
    orderedItems,
    alreadySent: (sent ?? []).map((reply) => reply.body),
  });

  if (!result.ok) {
    return {
      error: result.retryable
        ? `${result.error} Worth another go.`
        : result.error,
      notice: null,
    };
  }

  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  const row = {
    body: result.draft.body,
    author: "ai_draft" as const,
    edited_by_agent: false,
    model: result.model,
    prompt_version: result.promptVersion,
    last_error: null,
  };

  const { error } = existing
    ? await supabase.from("ticket_replies").update(row).eq("id", existing.id)
    : await supabase.from("ticket_replies").insert({
        ...row,
        tenant_id: who.tenantId,
        ticket_id: ticketId,
        created_by: who.userId,
      });

  if (error) {
    console.error("replies: could not store the draft", {
      code: error.code,
      message: error.message,
    });
    return { error: "The draft was written but not saved. Try again.", notice: null };
  }

  revalidatePath(`/tickets/${ticketId}`);

  const gaps = result.draft.gaps;
  return {
    error: null,
    notice: gaps.length
      ? `Drafted. Claude could not know: ${gaps.join("; ")}.`
      : "Drafted. Read it before you send it.",
  };
}

/**
 * Stores what is in the box, whoever wrote it. Saving is not sending, and a
 * saved draft is not visible to anyone outside the workspace.
 */
export async function saveDraft(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return { error: who.error, notice: null };
  }

  const ticketId = field(formData, "ticketId");
  const body = (field(formData, "body") ?? "").trim();

  if (!ticketId) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  if (!body) {
    return { error: "There is nothing in the box to save.", notice: null };
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id, body, author")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from("ticket_replies")
        .update({
          body,
          // Only true once the words actually differ from Claude's.
          edited_by_agent:
            existing.author === "ai_draft" && existing.body !== body,
        })
        .eq("id", existing.id)
    : await supabase.from("ticket_replies").insert({
        tenant_id: who.tenantId,
        ticket_id: ticketId,
        body,
        author: "agent",
        created_by: who.userId,
      });

  if (error) {
    console.error("replies: could not save the draft", {
      code: error.code,
      message: error.message,
    });
    return { error: "Could not save that. Try again.", notice: null };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null, notice: "Saved as a draft. Nothing has gone out." };
}

export async function discardDraft(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return { error: who.error, notice: null };
  }

  const ticketId = field(formData, "ticketId");
  if (!ticketId) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("ticket_replies")
    .delete()
    .eq("ticket_id", ticketId)
    .eq("status", "draft");

  if (error) {
    return { error: "Could not throw that away. Try again.", notice: null };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null, notice: "Draft thrown away." };
}

/**
 * Sends what is in the box, and only when a person has pressed this.
 *
 * The order of operations is the point. The draft is claimed first, by moving
 * it to 'sending', and that move only succeeds for whoever gets there first:
 * a second press, or a double click, finds nothing left to claim and stops
 * rather than sending the same words twice. Only then is the channel touched.
 * The words stored are the words submitted, so what the customer received and
 * what the workspace can see are the same text.
 */
export async function sendReply(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return { error: who.error, notice: null };
  }

  const ticketId = field(formData, "ticketId");
  const body = (field(formData, "body") ?? "").trim();

  if (!ticketId) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  if (!body) {
    return { error: "There is nothing in the box to send.", notice: null };
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, external_id, customer_email, channel_id, channels(type, status)",
    )
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return { error: "That ticket is not yours to reply to.", notice: null };
  }

  const blocked = sendBlockedOn({
    channelType: ticket.channels?.type ?? null,
    channelStatus: ticket.channels?.status ?? null,
    externalId: ticket.external_id,
    customerEmail: ticket.customer_email,
  });

  if (blocked) {
    return { error: blocked, notice: null };
  }

  // There is always a row before there is a send, so that the claim below has
  // something to claim and the words survive a failure.
  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id, author, body")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  let replyId = existing?.id ?? null;
  const author = existing?.author ?? "agent";
  const wordsBefore = existing?.body ?? body;

  if (!replyId) {
    const { data: created, error: createError } = await supabase
      .from("ticket_replies")
      .insert({
        tenant_id: who.tenantId,
        ticket_id: ticketId,
        body,
        author: "agent",
        created_by: who.userId,
      })
      .select("id")
      .single();

    if (createError || !created) {
      console.error("replies: could not stage the send", {
        code: createError?.code,
        message: createError?.message,
      });
      return { error: "Could not send that. Try again.", notice: null };
    }
    replyId = created.id;
  }

  // The claim. Only the press that moves the row out of draft goes on to the
  // channel; anything arriving after this finds nothing and says so.
  const { data: claimed } = await supabase
    .from("ticket_replies")
    .update({ status: "sending", body, last_error: null })
    .eq("id", replyId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return {
      error: "That reply is already on its way. Give it a moment.",
      notice: null,
    };
  }

  // The mailbox credential lives in a table the browser cannot read, so the
  // send itself is the one step that runs with the service role.
  const admin = createAdminClient();

  const { data: channel } = await admin
    .from("channels")
    .select("id, external_account_id, config")
    .eq("id", ticket.channel_id ?? "")
    .eq("tenant_id", who.tenantId)
    .maybeSingle();

  const outcome = channel
    ? await sendOutlookReply(admin, channel, ticket.external_id ?? "", body)
    : { ok: false as const, error: "That mailbox is no longer connected." };

  if (!outcome.ok) {
    // Back to a draft, with the reason. A failed send is something to fix and
    // try again, not a reason to make the agent write it twice.
    await supabase
      .from("ticket_replies")
      .update({ status: "draft", last_error: outcome.error })
      .eq("id", replyId);

    revalidatePath(`/tickets/${ticketId}`);
    return { error: outcome.error, notice: null };
  }

  const { error } = await supabase
    .from("ticket_replies")
    .update({
      status: "sent",
      sent_by: who.userId,
      sent_at: new Date().toISOString(),
      external_message_id: outcome.externalMessageId,
      last_error: null,
      // Only true once the words actually differ from Claude's.
      edited_by_agent: author === "ai_draft" && wordsBefore !== body,
    })
    .eq("id", replyId);

  if (error) {
    console.error("replies: sent but not recorded", {
      code: error.code,
      message: error.message,
    });
    // The customer has it. Saying otherwise would be worse than saying this.
    return {
      error:
        "The reply went out, but recording it here failed. Do not send it again.",
      notice: null,
    };
  }

  // Answering a ticket means work has started on it, so an unopened one stops
  // looking untouched.
  await supabase
    .from("tickets")
    .update({ status: "pending" })
    .eq("id", ticketId)
    .eq("status", "unopened");

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  revalidatePath("/");

  return { error: null, notice: "Sent." };
}

/**
 * The one entry point the composer posts to.
 *
 * Every button on the form names what it wants, and an unrecognised or
 * missing intent does nothing at all. Sending has its own intent, produced by
 * its own button, and no other path through this switch reaches it.
 */
export async function composeReply(
  previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  switch (field(formData, "intent")) {
    case "draft":
      return requestDraft(previous, formData);
    case "save":
      return saveDraft(previous, formData);
    case "discard":
      return discardDraft(previous, formData);
    case "send":
      return sendReply(previous, formData);
    default:
      return { error: "That is not something I can do with a reply.", notice: null };
  }
}
