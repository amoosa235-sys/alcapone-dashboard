"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getMembership, getUser } from "@/lib/auth";
import { processTicket, linkDuplicates } from "@/lib/pipeline/process";
import { draftReply, type ConversationEntry } from "@/lib/replies/draft";
import { sendOutcomeUnknown } from "@/lib/replies/outcome";
import { sendBlockedOn, sendOutlookReply, sentSince } from "@/lib/replies/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadTimeline, nextTicketId, replyTarget } from "@/lib/tickets/queries";
import { CATEGORY_LABELS, canMove, type TicketStatus } from "@/lib/tickets/view";
import { TICKET_STATUSES, type Enums } from "@/types/database";

import { EMPTY_TICKET_STATE, type TicketActionState } from "./state";

/**
 * Everything an agent does to a ticket.
 *
 * A server action is reachable by anyone who can POST to it, not only through
 * the page, so each one re-checks who is asking. Reads and ordinary writes go
 * through the user's own session so row level security decides what they can
 * touch. The admin client appears only where the database deliberately does
 * not let a member write: reading a mailbox credential, recording that a
 * reply was sent, and settling a send nobody could confirm. Each of those
 * first reads the row through the user's session, so a member can only reach
 * rows in their own workspace.
 *
 * Drafting and sending are two separate actions on purpose. Nothing in the
 * drafting path can reach the send path, so there is no sequence of events
 * that puts words in front of a customer without a person having pressed
 * send.
 */


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

function fail(error: string): TicketActionState {
  return { error, notice: null };
}

function refreshTicket(ticketId: string) {
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  revalidatePath("/");
}

/**
 * Where to go once a ticket is dealt with: the next one in the pile it came
 * from, with a note saying what just happened, or back to the pile when it
 * is empty.
 */
async function goToNext(
  pile: TicketStatus,
  finishedId: string,
  viewerId: string,
  done: "sent" | "closed" | "waiting" | "merged",
): Promise<never> {
  const next = await nextTicketId(pile, finishedId, viewerId);
  redirect(
    next
      ? `/tickets/${next}?done=${done}&from=${finishedId}`
      : `/tickets?status=${pile}&done=${done}`,
  );
}

/**
 * Moves a ticket between piles.
 *
 * The move is checked against the ticket as it stands rather than against
 * what the form claimed it was, so two agents on the same ticket cannot talk
 * each other into an impossible transition. Closing a ticket or handing it
 * to the customer is the end of dealing with it, so the next one opens.
 */
export async function moveTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  const to = field(formData, "to");

  if (!ticketId || !isTicketStatus(to)) {
    return fail("That is not a status I know about.");
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, status")
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return fail("That ticket is not yours to change.");
  }

  if (ticket.status === to) {
    return EMPTY_TICKET_STATE;
  }

  if (!canMove(ticket.status, to)) {
    return fail(`A ${ticket.status} ticket cannot go straight to ${to}.`);
  }

  const { error } = await supabase
    .from("tickets")
    .update({
      status: to,
      closed_at: to === "closed" ? new Date().toISOString() : null,
    })
    .eq("id", ticketId)
    // Only if nobody else moved it in the meantime.
    .eq("status", ticket.status);

  if (error) {
    console.error("tickets: could not move", { code: error.code, message: error.message });
    return fail("Could not change that. Try again.");
  }

  refreshTicket(ticketId);

  if (
    (to === "closed" || to === "waiting") &&
    (ticket.status === "unopened" || ticket.status === "pending")
  ) {
    await goToNext(ticket.status, ticketId, who.userId, to);
  }

  return EMPTY_TICKET_STATE;
}

/** Closes every ticket ticked on the list, in one go. */
export async function bulkClose(formData: FormData): Promise<void> {
  const who = await caller();
  if ("error" in who) {
    redirect("/login");
  }

  const back = field(formData, "back") ?? "/tickets";
  const safeBack = back.startsWith("/tickets") ? back : "/tickets";
  const ids = formData
    .getAll("ticketIds")
    .filter((value): value is string => typeof value === "string")
    .slice(0, 200);

  if (!ids.length) {
    redirect(safeBack);
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tickets")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .in("id", ids)
    .neq("status", "closed")
    .select("id");

  if (error) {
    console.error("tickets: bulk close failed", { code: error.code, message: error.message });
  }

  revalidatePath("/tickets");
  revalidatePath("/");
  const joiner = safeBack.includes("?") ? "&" : "?";
  redirect(`${safeBack}${joiner}done=closed&count=${data?.length ?? 0}`);
}

/** Gives a ticket to a colleague, to yourself, or to nobody. */
export async function assignTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  const assignee = field(formData, "assignee") || null;
  if (!ticketId) {
    return fail("That ticket is not yours to change.");
  }

  const supabase = await createClient();

  // Only somebody in this workspace can be given one of its tickets.
  if (assignee) {
    const { data: members } = await supabase.rpc("workspace_members");
    if (!(members ?? []).some((member) => member.user_id === assignee)) {
      return fail("That person is not in this workspace.");
    }
  }

  const { data, error } = await supabase
    .from("tickets")
    .update({ assigned_to: assignee })
    .eq("id", ticketId)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return fail("Could not change who has it. Try again.");
  }

  refreshTicket(ticketId);
  return {
    error: null,
    notice: assignee
      ? assignee === who.userId
        ? "It is yours."
        : "Handed over."
      : "Nobody has it now.",
  };
}

/**
 * An agent saying what Claude got wrong. The correction replaces what the
 * ticket shows, is kept in the history as the agent's, and the duplicate
 * matching runs again on the corrected order number and phone.
 */
export async function correctClassification(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  const category = field(formData, "category");
  if (!ticketId || !category || !(category in CATEGORY_LABELS)) {
    return fail("Pick what kind of ticket this is.");
  }

  const text = (name: string) => (field(formData, name) ?? "").trim().slice(0, 200) || null;

  const supabase = await createClient();
  const { data: changed, error } = await supabase.rpc("correct_classification", {
    p_ticket_id: ticketId,
    p_category: category as Enums<"ticket_category">,
    p_order_number: text("orderNumber"),
    p_customer_name: text("customerName"),
    p_contact_number: text("contactNumber"),
    p_item_needing_attention: text("item"),
  });

  if (error) {
    console.error("tickets: correction failed", { code: error.code, message: error.message });
    return fail("Could not save the correction. Try again.");
  }

  if (!changed) {
    return { error: null, notice: "Nothing changed, so nothing was saved." };
  }

  // The rpc checked the ticket is in the caller's workspace before changing
  // anything, so matching it again as the service role reaches nothing else.
  await linkDuplicates(createAdminClient(), who.tenantId, ticketId);

  refreshTicket(ticketId);
  return { error: null, notice: "Corrected. Thank you, this is how Claude gets checked." };
}

/** Asks Claude again about a ticket it gave up on. */
export async function retryClassification(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  if (!ticketId) {
    return fail("That ticket is not yours to change.");
  }

  const supabase = await createClient();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) {
    return fail("That ticket is not yours to change.");
  }

  const admin = createAdminClient();
  await admin
    .from("tickets")
    .update({
      classification_status: "pending",
      classification_attempts: 0,
      classification_retry_at: null,
    })
    .eq("id", ticketId)
    .eq("tenant_id", who.tenantId);

  const result = await processTicket(admin, who.tenantId, ticketId);
  refreshTicket(ticketId);

  return result.classified
    ? { error: null, notice: "Sorted." }
    : fail(`Claude still could not sort it: ${result.classificationError ?? "no reason given"}`);
}

/** Says whether a suggested duplicate really is the same issue. */
export async function reviewDuplicate(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const linkId = field(formData, "linkId");
  const ticketId = field(formData, "ticketId");
  const verdict = field(formData, "verdict");
  if (!linkId || !ticketId || (verdict !== "confirmed" && verdict !== "rejected")) {
    return fail("That is not something I can do with a match.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("duplicate_links")
    .update({
      status: verdict,
      reviewed_by: who.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", linkId)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return fail("Could not save that. Try again.");
  }

  refreshTicket(ticketId);
  return {
    error: null,
    notice: verdict === "rejected" ? "Not the same. It will not be suggested again." : "Marked as the same issue.",
  };
}

/**
 * Folds one ticket into another. The merged ticket is closed and points at
 * the one it went into; its messages show on that ticket's conversation, and
 * anything the customer sends on its thread later lands there too.
 */
export async function mergeTicket(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const sourceId = field(formData, "ticketId");
  const targetId = field(formData, "intoTicketId");
  const linkId = field(formData, "linkId");
  if (!sourceId || !targetId || sourceId === targetId) {
    return fail("Pick a different ticket to merge into.");
  }

  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("tickets")
    .select("id, status, merged_into_ticket_id")
    .in("id", [sourceId, targetId]);

  const source = rows?.find((row) => row.id === sourceId);
  const target = rows?.find((row) => row.id === targetId);
  if (!source || !target) {
    return fail("Those tickets are not yours to merge.");
  }
  if (source.merged_into_ticket_id) {
    return fail("This ticket has already been merged.");
  }
  if (target.merged_into_ticket_id) {
    return fail("That ticket was itself merged into another. Merge into that one instead.");
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("tickets")
    .update({ merged_into_ticket_id: targetId, status: "closed", closed_at: now })
    .eq("id", sourceId)
    .is("merged_into_ticket_id", null);

  if (error) {
    console.error("tickets: merge failed", { code: error.code, message: error.message });
    return fail("Could not merge those. Try again.");
  }

  // Anything already merged into this one follows it, so the chain stays one
  // step long.
  await supabase
    .from("tickets")
    .update({ merged_into_ticket_id: targetId })
    .eq("merged_into_ticket_id", sourceId);

  // A question still waiting for a reply does not disappear into an answered
  // ticket.
  if (
    (source.status === "unopened" || source.status === "pending") &&
    (target.status === "waiting" || target.status === "closed")
  ) {
    await supabase
      .from("tickets")
      .update({ status: "pending", closed_at: null })
      .eq("id", targetId);
  }

  if (linkId) {
    await supabase
      .from("duplicate_links")
      .update({ status: "confirmed", reviewed_by: who.userId, reviewed_at: now })
      .eq("id", linkId);
  }

  refreshTicket(sourceId);
  refreshTicket(targetId);
  redirect(`/tickets/${targetId}?done=merged&from=${sourceId}`);
}

/** Everything a draft needs to know about the conversation so far. */
async function conversationFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticket: {
    id: string;
    subject: string | null;
    body: string | null;
    customer_name: string | null;
    customer_email: string | null;
    received_at: string;
    external_id: string | null;
  },
): Promise<ConversationEntry[]> {
  const { timeline } = await loadTimeline(supabase, ticket);
  return timeline.map((entry) => ({
    from: entry.kind === "customer" ? "customer" : "us",
    at: entry.at,
    text: (entry.body ?? "").trim(),
  }));
}

/**
 * Asks Claude for a draft and stores it as one. It is not sent, not queued,
 * and not shown to anybody outside the workspace; it is a row an agent can
 * rewrite or throw away.
 *
 * A draft a person has written or edited is not replaced without asking:
 * the first press says so, and only a second, confirming press replaces it.
 */
export async function requestDraft(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  if (!ticketId) {
    return fail("That ticket is not yours to reply to.");
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, subject, body, customer_name, customer_email, received_at, external_id, order_number, channels(type)",
    )
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return fail("That ticket is not yours to reply to.");
  }

  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id, body, author, edited_by_agent")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  const inTheBox = (field(formData, "body") ?? "").trim();
  const storedIsUntouchedClaude =
    existing?.author === "ai_draft" && !existing.edited_by_agent;
  const personsWords =
    (existing && !storedIsUntouchedClaude) ||
    (inTheBox.length > 0 && inTheBox !== (existing?.body ?? "").trim());

  if (personsWords && field(formData, "confirmReplace") !== "1") {
    return {
      error: null,
      notice: "There are words in the reply that a person wrote. Press again to replace them with Claude's draft.",
      confirmReplace: true,
    };
  }

  const [{ data: classification }, conversation] = await Promise.all([
    supabase
      .from("ticket_classifications")
      .select("category, summary, item_needing_attention, ordered_items")
      .eq("ticket_id", ticketId)
      .is("superseded_at", null)
      .maybeSingle(),
    conversationFor(supabase, ticket),
  ]);

  const orderedItems = Array.isArray(classification?.ordered_items)
    ? (classification.ordered_items as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const row = entry as Record<string, unknown>;
        return typeof row.name === "string"
          ? [{ name: row.name, quantity: typeof row.quantity === "number" ? row.quantity : null }]
          : [];
      })
    : [];

  const result = await draftReply({
    workspaceName: who.tenantName,
    channel: ticket.channels?.type ?? "unknown",
    subject: ticket.subject,
    conversation,
    customerName: ticket.customer_name,
    orderNumber: ticket.order_number,
    category: classification?.category ?? null,
    summary: classification?.summary ?? null,
    itemNeedingAttention: classification?.item_needing_attention ?? null,
    orderedItems,
  });

  if (!result.ok) {
    return fail(result.retryable ? `${result.error} Worth another go.` : result.error);
  }

  const row = {
    body: result.draft.body,
    author: "ai_draft" as const,
    edited_by_agent: false,
    model: result.model,
    prompt_version: result.promptVersion,
    last_error: null,
  };

  const { error } = existing
    ? await supabase
        .from("ticket_replies")
        .update(row)
        .eq("id", existing.id)
        .eq("status", "draft")
    : await supabase.from("ticket_replies").insert({
        ...row,
        tenant_id: who.tenantId,
        ticket_id: ticketId,
        created_by: who.userId,
      });

  if (error) {
    console.error("replies: could not store the draft", { code: error.code, message: error.message });
    return fail("The draft was written but not saved. Try again.");
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
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  const body = (field(formData, "body") ?? "").trim();

  if (!ticketId) {
    return fail("That ticket is not yours to reply to.");
  }

  if (!body) {
    return fail("There is nothing in the box to save.");
  }

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id, body, author, edited_by_agent")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from("ticket_replies")
        .update({
          body,
          // Once edited, always edited: saving Claude's words back unchanged
          // later does not make them Claude's again.
          edited_by_agent:
            existing.edited_by_agent ||
            (existing.author === "ai_draft" && existing.body !== body),
        })
        .eq("id", existing.id)
        .eq("status", "draft")
    : await supabase.from("ticket_replies").insert({
        tenant_id: who.tenantId,
        ticket_id: ticketId,
        body,
        author: "agent",
        created_by: who.userId,
      });

  if (error) {
    console.error("replies: could not save the draft", { code: error.code, message: error.message });
    return fail("Could not save that. Try again.");
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
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  if (!ticketId) {
    return fail("That ticket is not yours to reply to.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("ticket_replies")
    .delete()
    .eq("ticket_id", ticketId)
    .eq("status", "draft");

  if (error) {
    return fail("Could not throw that away. Try again.");
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null, notice: "Draft thrown away." };
}

/**
 * Sends what is in the box, and only when a person has pressed this.
 *
 * The order of operations is the point. The draft is claimed first, by moving
 * it to 'sending' with who claimed it and when, and that move only succeeds
 * for whoever gets there first: a second press, or a double click, finds
 * nothing left to claim and stops rather than sending the same words twice.
 * Only then is the channel touched. The words stored are the words
 * submitted, so what the customer received and what the workspace can see
 * are the same text.
 *
 * Recording the reply as sent is done by the server, not the member's
 * session: the database does not let a member call a reply sent, so the
 * audit trail is something only a real send can write.
 */
export async function sendReply(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const ticketId = field(formData, "ticketId");
  const body = (field(formData, "body") ?? "").trim();

  if (!ticketId) {
    return fail("That ticket is not yours to reply to.");
  }

  if (!body) {
    return fail("There is nothing in the box to send.");
  }

  const supabase = await createClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, status, external_id, customer_email, channel_id, channels(type, status)")
    .eq("id", ticketId)
    .maybeSingle();

  if (!ticket) {
    return fail("That ticket is not yours to reply to.");
  }

  const replyToMessageId = await replyTarget(supabase, ticket);
  const blocked = sendBlockedOn({
    channelType: ticket.channels?.type ?? null,
    channelStatus: ticket.channels?.status ?? null,
    replyToMessageId,
    customerEmail: ticket.customer_email,
  });

  if (blocked) {
    return fail(blocked);
  }

  const { data: inFlight } = await supabase
    .from("ticket_replies")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("status", "sending")
    .limit(1);

  if (inFlight?.length) {
    return fail("A reply on this ticket has not confirmed yet. Settle that one first.");
  }

  // There is always a row before there is a send, so that the claim below has
  // something to claim and the words survive a failure.
  const { data: existing } = await supabase
    .from("ticket_replies")
    .select("id, author, body, edited_by_agent")
    .eq("ticket_id", ticketId)
    .eq("status", "draft")
    .maybeSingle();

  let replyId = existing?.id ?? null;
  const edited =
    Boolean(existing?.edited_by_agent) ||
    (existing?.author === "ai_draft" && existing.body !== body);

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
      return fail("Could not send that. Try again.");
    }
    replyId = created.id;
  }

  // The claim. Only the press that moves the row out of draft goes on to the
  // channel; anything arriving after this finds nothing and says so.
  const { data: claimed } = await supabase
    .from("ticket_replies")
    .update({
      status: "sending",
      body,
      last_error: null,
      edited_by_agent: edited,
      sending_started_at: new Date().toISOString(),
      claimed_by: who.userId,
    })
    .eq("id", replyId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return fail("That reply is already on its way. Give it a moment.");
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
    ? await sendOutlookReply(admin, channel, replyToMessageId ?? "", body)
    : { ok: false as const, error: "That mailbox is no longer connected." };

  if (!outcome.ok) {
    // Back to a draft, with the reason. A failed send is something to fix and
    // try again, not a reason to make the agent write it twice.
    await supabase
      .from("ticket_replies")
      .update({
        status: "draft",
        last_error: outcome.error,
        claimed_by: null,
        sending_started_at: null,
      })
      .eq("id", replyId);

    revalidatePath(`/tickets/${ticketId}`);
    return fail(outcome.error);
  }

  const { data: recorded, error } = await admin
    .from("ticket_replies")
    .update({
      status: "sent",
      sent_by: who.userId,
      sent_at: new Date().toISOString(),
      external_message_id: outcome.externalMessageId,
      last_error: null,
    })
    .eq("id", replyId)
    .eq("tenant_id", who.tenantId)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();

  if (error || !recorded) {
    console.error("replies: sent but not recorded", { code: error?.code, message: error?.message });
    // The customer has it. Saying otherwise would be worse than saying this.
    return fail("The reply went out, but recording it here failed. Do not send it again.");
  }

  // The ball is in the customer's court. Their next message brings the ticket
  // back to Pending on its own.
  await supabase
    .from("tickets")
    .update({ status: "waiting", closed_at: null })
    .eq("id", ticketId)
    .in("status", ["unopened", "pending"]);

  refreshTicket(ticketId);

  if (ticket.status === "unopened" || ticket.status === "pending") {
    await goToNext(ticket.status, ticketId, who.userId, "sent");
  }
  return { error: null, notice: "Sent." };
}

/**
 * Settles a send that never confirmed. Nobody knows whether the customer got
 * it, so the agent chooses: look in the mailbox's Sent Items, say it went,
 * or say it did not and have the words back as a draft.
 */
export async function resolveStuckSend(
  _previous: TicketActionState,
  formData: FormData,
): Promise<TicketActionState> {
  const who = await caller();
  if ("error" in who) {
    return fail(who.error);
  }

  const replyId = field(formData, "replyId");
  const how = field(formData, "how");
  if (!replyId || (how !== "check" && how !== "went" && how !== "not-went")) {
    return fail("That is not something I can do with a reply.");
  }

  const supabase = await createClient();
  const { data: reply } = await supabase
    .from("ticket_replies")
    .select("id, ticket_id, status, sending_started_at, updated_at, claimed_by")
    .eq("id", replyId)
    .maybeSingle();

  if (!reply) {
    return fail("That reply is not yours to settle.");
  }
  if (!sendOutcomeUnknown(reply)) {
    return fail("That reply is not stuck. Reload to see where it is.");
  }

  const admin = createAdminClient();
  const startedAt = reply.sending_started_at ?? reply.updated_at;

  let went: boolean;
  let note: string;

  if (how === "check") {
    const { data: ticket } = await admin
      .from("tickets")
      .select("external_thread_id, channel_id")
      .eq("id", reply.ticket_id)
      .eq("tenant_id", who.tenantId)
      .maybeSingle();
    const { data: channel } = await admin
      .from("channels")
      .select("id, external_account_id, config")
      .eq("id", ticket?.channel_id ?? "")
      .eq("tenant_id", who.tenantId)
      .maybeSingle();

    if (!ticket?.external_thread_id || !channel) {
      return fail("There is no mailbox conversation to look in. Say whether it went instead.");
    }

    const found = await sentSince(admin, channel, ticket.external_thread_id, startedAt);
    if ("error" in found) {
      return fail(`Could not look in Sent Items: ${found.error}`);
    }
    went = found.sent;
    note = went
      ? "Could not confirm at the time; found in the mailbox's Sent Items afterwards."
      : "Could not confirm at the time; nothing in the mailbox's Sent Items, so it did not go.";
  } else {
    went = how === "went";
    note = went
      ? "Could not confirm at the time; a person said it went."
      : "Could not confirm at the time; a person said it did not go.";
  }

  const { data: settled, error } = await admin
    .from("ticket_replies")
    .update(
      went
        ? {
            status: "sent" as const,
            sent_by: reply.claimed_by ?? who.userId,
            sent_at: startedAt,
            send_note: note,
            last_error: null,
          }
        : {
            status: "draft" as const,
            claimed_by: null,
            sending_started_at: null,
            send_note: note,
            last_error: "The last send could not confirm and did not go out. It is back here to send again.",
          },
    )
    .eq("id", reply.id)
    .eq("tenant_id", who.tenantId)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();

  if (error || !settled) {
    return fail("Could not settle that. Reload and try again.");
  }

  if (went) {
    await supabase
      .from("tickets")
      .update({ status: "waiting", closed_at: null })
      .eq("id", reply.ticket_id)
      .in("status", ["unopened", "pending"]);
  }

  refreshTicket(reply.ticket_id);
  return {
    error: null,
    notice: went ? "Recorded as sent." : "It did not go. The words are back in the box to send again.",
  };
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
      return fail("That is not something I can do with a reply.");
  }
}
