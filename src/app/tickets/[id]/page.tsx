import Link from "next/link";
import { notFound } from "next/navigation";

import { requireMembership } from "@/lib/auth";
import { sendBlockedOn } from "@/lib/replies/send";
import { getTicket } from "@/lib/tickets/queries";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  CONFIDENT_ENOUGH,
  STATUS_LABELS,
  confidencePercent,
  previewLine,
  timeAgo,
} from "@/lib/tickets/view";

import { MoveButtons } from "../move-buttons";
import { ReplyComposer } from "../reply-composer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket" };

/**
 * One ticket, and everything an agent needs to deal with it: what the
 * customer said, what Claude read out of it, anything that turned out to be
 * the same issue arriving elsewhere, and the reply.
 */
export default async function TicketPage({ params }: PageProps<"/tickets/[id]">) {
  await requireMembership();

  const { id } = await params;
  const ticket = await getTicket(id);

  if (!ticket) {
    notFound();
  }

  const extracted = ticket.classification;
  const confidence = confidencePercent(extracted?.confidence ?? null);
  const unsure =
    extracted !== null && (extracted.confidence ?? 1) < CONFIDENT_ENOUGH;

  const draft = ticket.replies.find((reply) => reply.status === "draft") ?? null;
  const sent = ticket.replies.filter((reply) => reply.status === "sent");
  const inFlight =
    ticket.replies.find((reply) => reply.status === "sending") ?? null;

  // A reply already on its way is the one thing that stops another going out,
  // over and above whether the channel could carry it at all.
  const blockedReason = inFlight
    ? "A reply is already on its way on this ticket. Reload in a moment to see whether it landed."
    : sendBlockedOn({
        channelType: ticket.channelType,
        channelStatus: ticket.channelStatus,
        externalId: ticket.externalId,
        customerEmail: ticket.customerEmail,
      });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-16">
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
          <span>Arrived {timeAgo(ticket.receivedAt)}</span>
        </p>
      </header>

      <MoveButtons ticketId={ticket.id} status={ticket.status} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">What they said</h2>
        <p className="whitespace-pre-wrap rounded-lg border border-black/10 p-4 text-sm leading-relaxed dark:border-white/15">
          {ticket.body?.trim() || "This message arrived with no text."}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">What Claude read out of it</h2>

        {extracted ? (
          <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
            <p className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs dark:border-white/20">
                {CATEGORY_LABELS[extracted.category]}
              </span>
              {confidence !== null ? (
                <span className="text-xs text-black/60 dark:text-white/60">
                  {unsure
                    ? `Only ${confidence}% sure, so check it`
                    : `${confidence}% sure`}
                </span>
              ) : null}
            </p>

            {extracted.summary ? <p>{extracted.summary}</p> : null}

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <Fact label="Name" value={ticket.customerName} />
              <Fact label="Email" value={ticket.customerEmail} />
              <Fact label="Phone" value={ticket.customerPhone} />
              <Fact label="Order" value={ticket.orderNumber} />
              <Fact
                label="Item at issue"
                value={extracted.itemNeedingAttention}
              />
              <Fact
                label="On the order"
                value={
                  extracted.orderedItems.length
                    ? extracted.orderedItems
                        .map((item) =>
                          item.quantity && item.quantity > 1
                            ? `${item.name} ×${item.quantity}`
                            : item.name,
                        )
                        .join(", ")
                    : null
                }
              />
            </dl>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-black/15 p-4 text-sm text-black/60 dark:border-white/20 dark:text-white/60">
            Not sorted yet. The recurring job picks up anything still waiting,
            and the Channels page has a button to run it now.
          </p>
        )}
      </section>

      {ticket.duplicates.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">
            The same issue, somewhere else
          </h2>
          <ul className="flex flex-col gap-2">
            {ticket.duplicates.map((duplicate) => (
              <li
                key={duplicate.ticketId}
                className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm"
              >
                <Link
                  href={`/tickets/${duplicate.ticketId}`}
                  className="font-medium underline"
                >
                  {previewLine(duplicate.subject, null)}
                </Link>
                <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                  {duplicate.channelType
                    ? `${CHANNEL_LABELS[duplicate.channelType]} · `
                    : ""}
                  {timeAgo(duplicate.receivedAt)}
                  {duplicate.matchReason ? ` · ${duplicate.matchReason}` : ""}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-black/60 dark:text-white/60">
            Answer one of them. Merging them into a single ticket is not built
            yet, so both stay in the list for now.
          </p>
        </section>
      ) : null}

      {sent.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Already sent</h2>
          {sent.map((reply) => (
            <div
              key={reply.id}
              className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15"
            >
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {reply.body}
              </p>
              <p className="text-xs text-black/50 dark:text-white/50">
                Sent {reply.sent_at ? timeAgo(reply.sent_at) : "at some point"}
                {reply.author === "ai_draft"
                  ? reply.edited_by_agent
                    ? " · drafted by Claude, edited before sending"
                    : " · drafted by Claude, sent as written"
                  : " · written by hand"}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
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
        />
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
