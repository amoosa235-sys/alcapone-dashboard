import Link from "next/link";
import { notFound } from "next/navigation";

import { requireMembership } from "@/lib/auth";
import { sendOutcomeUnknown } from "@/lib/replies/outcome";
import { sendBlockedOn } from "@/lib/replies/send";
import { getTicket, listMembers, listSavedReplies } from "@/lib/tickets/queries";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  CONFIDENT_ENOUGH,
  STATUS_LABELS,
  confidencePercent,
  previewLine,
  timeAgo,
} from "@/lib/tickets/view";

import { ActionForm } from "../action-form";
import {
  assignTicket,
  correctClassification,
  mergeTicket,
  resolveStuckSend,
  retryClassification,
  reviewDuplicate,
} from "../actions";
import { MoveButtons } from "../move-buttons";
import { ReplyComposer } from "../reply-composer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket" };

const DONE_NOTES: Record<string, string> = {
  sent: "Sent, and that ticket is now waiting on the customer. Here is the next one.",
  closed: "Closed. Here is the next one.",
  waiting: "Handed to the customer. Here is the next one.",
  merged: "Merged into this ticket.",
};

const input =
  "rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20";

/**
 * One ticket, and everything an agent needs to deal with it: the whole
 * conversation, what Claude read out of it and a way to correct that, who
 * has it, anything that looks like the same issue arriving elsewhere, the
 * customer's order history and other tickets, and the reply.
 */
export default async function TicketPage({ params, searchParams }: PageProps<"/tickets/[id]">) {
  const { user, membership } = await requireMembership();

  const { id } = await params;
  const query = await searchParams;
  const [ticket, members, savedReplies] = await Promise.all([
    getTicket(id),
    listMembers(),
    listSavedReplies(),
  ]);

  if (!ticket) {
    notFound();
  }

  const done = typeof query.done === "string" ? (DONE_NOTES[query.done] ?? null) : null;
  const extracted = ticket.classification;
  const confidence = confidencePercent(extracted?.confidence ?? null);
  const unsure =
    extracted !== null && extracted.source === "claude" && (extracted.confidence ?? 1) < CONFIDENT_ENOUGH;

  const draft = ticket.replies.find((reply) => reply.status === "draft") ?? null;
  const inFlight = ticket.replies.find((reply) => reply.status === "sending") ?? null;
  const stuck = inFlight && sendOutcomeUnknown(inFlight) ? inFlight : null;

  // A reply already on its way is the one thing that stops another going out,
  // over and above whether the channel could carry it at all.
  const blockedReason = stuck
    ? "The last reply never confirmed. Settle it above before sending another."
    : inFlight
      ? "A reply is already on its way on this ticket. Reload in a moment to see whether it landed."
      : sendBlockedOn({
          channelType: ticket.channelType,
          channelStatus: ticket.channelStatus,
          replyToMessageId: ticket.replyToMessageId,
          customerEmail: ticket.customerEmail,
        });

  const assignee = members.find((member) => member.userId === ticket.assignedTo) ?? null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-16">
      {done ? (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
          {done}
        </p>
      ) : null}

      <header className="flex flex-col gap-3">
        <Link href={`/tickets?status=${ticket.status}`} className="text-xs underline">
          Back to {STATUS_LABELS[ticket.status].toLowerCase()}
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">
          {previewLine(ticket.subject, ticket.body, 120)}
        </h1>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-black/60 dark:text-white/60">
          <span>{STATUS_LABELS[ticket.status]}</span>
          {ticket.channelType ? (
            <span>
              {CHANNEL_LABELS[ticket.channelType]}
              {ticket.channelName ? ` · ${ticket.channelName}` : ""}
            </span>
          ) : null}
          <span>Started {timeAgo(ticket.receivedAt)}</span>
          {ticket.lastMessageAt !== ticket.receivedAt ? (
            <span>Last message {timeAgo(ticket.lastMessageAt)}</span>
          ) : null}
        </p>
      </header>

      {ticket.mergedIntoTicketId ? (
        <p className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20">
          This ticket was merged.{" "}
          <Link href={`/tickets/${ticket.mergedIntoTicketId}`} className="underline">
            Open the ticket it went into
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <MoveButtons ticketId={ticket.id} status={ticket.status} />
          <ActionForm
            action={assignTicket}
            hidden={{ ticketId: ticket.id }}
            buttons={[{ label: "Assign" }]}
            className="flex items-start gap-2"
          >
            <select
              name="assignee"
              defaultValue={ticket.assignedTo ?? ""}
              aria-label="Who has this ticket"
              className={input}
            >
              <option value="">Nobody</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.userId === user.id ? `Me (${member.email})` : member.email}
                </option>
              ))}
            </select>
          </ActionForm>
        </div>
      )}

      {assignee && assignee.userId !== user.id ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          {assignee.email} has this one.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">The conversation</h2>
        <ol className="flex flex-col gap-3">
          {ticket.timeline.map((entry) =>
            entry.kind === "customer" ? (
              <li
                key={entry.id}
                className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15"
              >
                <p className="text-xs text-black/50 dark:text-white/50">
                  {entry.senderName ?? entry.senderEmail ?? "The customer"} · {timeAgo(entry.at)}
                  {entry.fromMergedTicket ? " · from a merged ticket" : ""}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {entry.body?.trim() || "This message arrived with no text."}
                </p>
              </li>
            ) : (
              <li
                key={entry.id}
                className="ml-8 flex flex-col gap-2 rounded-lg border border-black/10 bg-black/[.03] p-4 dark:border-white/15 dark:bg-white/[.04]"
              >
                <p className="text-xs text-black/50 dark:text-white/50">
                  We replied · {timeAgo(entry.at)}
                  {entry.author === "ai_draft"
                    ? entry.editedByAgent
                      ? " · drafted by Claude, edited before sending"
                      : " · drafted by Claude, sent as written"
                    : " · written by hand"}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.body}</p>
                {entry.sendNote ? (
                  <p className="text-xs text-black/50 dark:text-white/50">{entry.sendNote}</p>
                ) : null}
              </li>
            ),
          )}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">What Claude read out of it</h2>

        {extracted ? (
          <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
            <p className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs dark:border-white/20">
                {CATEGORY_LABELS[extracted.category]}
              </span>
              {extracted.source === "agent" ? (
                <span className="text-xs text-black/60 dark:text-white/60">Corrected by a person</span>
              ) : confidence !== null ? (
                <span className="text-xs text-black/60 dark:text-white/60">
                  {unsure ? `Only ${confidence}% sure, so check it` : `${confidence}% sure`}
                </span>
              ) : null}
            </p>

            {extracted.summary ? <p>{extracted.summary}</p> : null}

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <Fact label="Name" value={ticket.customerName} />
              <Fact label="Email" value={ticket.customerEmail} />
              <Fact label="Phone" value={ticket.customerPhone} />
              <Fact label="Order" value={ticket.orderNumber} />
              <Fact label="Item at issue" value={extracted.itemNeedingAttention} />
              <Fact
                label="On the order"
                value={
                  extracted.orderedItems.length
                    ? extracted.orderedItems
                        .map((item) =>
                          item.quantity && item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name,
                        )
                        .join(", ")
                    : null
                }
              />
            </dl>
          </div>
        ) : ticket.classificationStatus === "failed" ? (
          <div className="flex flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm">
            <p>
              Claude could not sort this one and has stopped trying
              {ticket.classificationError ? `: ${ticket.classificationError}` : "."}
            </p>
            <ActionForm
              action={retryClassification}
              hidden={{ ticketId: ticket.id }}
              buttons={[{ label: "Try Claude again" }]}
            />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-black/15 p-4 text-sm text-black/60 dark:border-white/20 dark:text-white/60">
            Not sorted yet. The scheduled job picks up anything still waiting within a few minutes.
          </p>
        )}

        <details className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
          <summary className="cursor-pointer">
            {extracted ? "Something wrong? Correct it" : "Sort it yourself"}
          </summary>
          <ActionForm
            action={correctClassification}
            hidden={{ ticketId: ticket.id }}
            buttons={[{ label: "Save the correction", primary: true }]}
            className="mt-3 flex flex-col gap-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-black/60 dark:text-white/60">Kind</span>
                <select name="category" defaultValue={extracted?.category ?? "enquiry"} className={input}>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <Field label="Order number" name="orderNumber" value={ticket.orderNumber} />
              <Field label="Customer name" name="customerName" value={ticket.customerName} />
              <Field label="Phone" name="contactNumber" value={ticket.customerPhone} />
              <Field label="Item at issue" name="item" value={extracted?.itemNeedingAttention ?? null} />
            </div>
          </ActionForm>
        </details>
      </section>

      {ticket.duplicates.length && !ticket.mergedIntoTicketId ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Possibly the same issue</h2>
          <ul className="flex flex-col gap-2">
            {ticket.duplicates.map((duplicate) => (
              <li
                key={duplicate.linkId}
                className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
              >
                <div>
                  <Link href={`/tickets/${duplicate.ticketId}`} className="font-medium underline">
                    {previewLine(duplicate.subject, null)}
                  </Link>
                  <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                    {duplicate.channelType ? `${CHANNEL_LABELS[duplicate.channelType]} · ` : ""}
                    {timeAgo(duplicate.receivedAt)}
                    {duplicate.matchReason ? ` · ${duplicate.matchReason}` : ""}
                    {duplicate.linkStatus === "confirmed" ? " · confirmed the same" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <ActionForm
                    action={mergeTicket}
                    hidden={{
                      ticketId: duplicate.ticketId,
                      intoTicketId: ticket.id,
                      linkId: duplicate.linkId,
                    }}
                    buttons={[{ label: "Same issue: merge it into this one", primary: true }]}
                  />
                  {duplicate.linkStatus === "suggested" ? (
                    <ActionForm
                      action={reviewDuplicate}
                      hidden={{ linkId: duplicate.linkId, ticketId: ticket.id }}
                      buttons={[{ label: "Not the same", name: "verdict", value: "rejected" }]}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ticket.orderHistory.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Order history</h2>
          <ul className="flex flex-col gap-2">
            {ticket.orderHistory.map((event) => (
              <li
                key={event.id}
                className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
              >
                <p className="text-xs text-black/50 dark:text-white/50">
                  {event.kind === "refunded" ? "Refund" : "Cancellation"}
                  {event.orderNumber ? ` · ${event.orderNumber}` : ""} · {timeAgo(event.occurredAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{event.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ticket.otherTickets.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">This customer&rsquo;s other tickets</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {ticket.otherTickets.map((other) => (
              <li key={other.id} className="flex flex-wrap items-baseline gap-2">
                <Link href={`/tickets/${other.id}`} className="underline">
                  {previewLine(other.subject, other.body)}
                </Link>
                <span className="text-xs text-black/50 dark:text-white/50">
                  {STATUS_LABELS[other.status]}
                  {other.channelType ? ` · ${CHANNEL_LABELS[other.channelType]}` : ""} ·{" "}
                  {timeAgo(other.receivedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        {stuck ? (
          <div className="flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm">
            <p>
              A reply was sent {timeAgo(stuck.sending_started_at ?? stuck.updated_at)} but never
              confirmed, so nobody knows whether the customer got it. Look in the mailbox&rsquo;s
              Sent Items, or say what happened.
            </p>
            <p className="whitespace-pre-wrap rounded border border-black/10 p-3 text-xs dark:border-white/15">
              {stuck.body}
            </p>
            <ActionForm
              action={resolveStuckSend}
              hidden={{ replyId: stuck.id }}
              buttons={[
                { label: "Look in Sent Items", name: "how", value: "check", primary: true },
                { label: "It went", name: "how", value: "went" },
                { label: "It did not go", name: "how", value: "not-went" },
              ]}
            />
          </div>
        ) : null}

        {draft?.last_error ? (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed">
            The last attempt to send this did not go through: {draft.last_error}
          </p>
        ) : null}

        <ReplyComposer
          ticketId={ticket.id}
          initialBody={draft?.body ?? inFlight?.body ?? ""}
          draftIsClaudes={draft?.author === "ai_draft" && !draft.edited_by_agent}
          blockedReason={blockedReason}
          savedReplies={savedReplies}
          templateValues={{
            name: ticket.customerName,
            order: ticket.orderNumber,
            item: extracted?.itemNeedingAttention ?? null,
            workspace: membership.tenantName,
          }}
        />
        {savedReplies.length === 0 ? (
          <p className="text-xs text-black/50 dark:text-white/50">
            Answers you give every day can be{" "}
            <Link href="/replies" className="underline">
              saved once and reused
            </Link>
            .
          </p>
        ) : null}
      </section>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }

  return (
    <>
      <dt className="text-black/50 dark:text-white/50">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function Field({ label, name, value }: { label: string; name: string; value: string | null }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-black/60 dark:text-white/60">{label}</span>
      <input name={name} defaultValue={value ?? ""} maxLength={200} className={input} />
    </label>
  );
}
