import Link from "next/link";

import { requireMembership } from "@/lib/auth";
import { countTicketsByStatus, listTickets } from "@/lib/tickets/queries";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  CONFIDENT_ENOUGH,
  STATUS_BLURBS,
  STATUS_LABELS,
  confidencePercent,
  previewLine,
  timeAgo,
} from "@/lib/tickets/view";
import { TICKET_STATUSES, type Enums } from "@/types/database";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets" };

/**
 * The inbox: everything that has come in, in the three piles the dashboard
 * has always been described in.
 *
 * The status is a query string rather than three routes, because it is one
 * list read three ways and an agent flips between them constantly.
 */
export default async function TicketsPage({
  searchParams,
}: PageProps<"/tickets">) {
  await requireMembership();

  const params = await searchParams;
  const requested = typeof params.status === "string" ? params.status : null;
  const status: Enums<"ticket_status"> = (
    TICKET_STATUSES as readonly string[]
  ).includes(requested ?? "")
    ? (requested as Enums<"ticket_status">)
    : "unopened";

  const [counts, tickets] = await Promise.all([
    countTicketsByStatus(),
    listTickets(status),
  ]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs underline">
          Back to the dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {STATUS_BLURBS[status]}
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TICKET_STATUSES.map((value) => {
          const active = value === status;
          return (
            <Link
              key={value}
              href={`/tickets?status=${value}`}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
                  : "rounded-md border border-black/10 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              }
            >
              {STATUS_LABELS[value]}
              <span className="ml-2 tabular-nums opacity-60">
                {counts[value]}
              </span>
            </Link>
          );
        })}
      </nav>

      {tickets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm text-black/60 dark:border-white/20 dark:text-white/60">
          Nothing {STATUS_LABELS[status].toLowerCase()}.{" "}
          <Link href="/channels" className="underline">
            Connect a channel
          </Link>{" "}
          and tickets arrive here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.map((ticket) => {
            const confidence = confidencePercent(
              ticket.classification?.confidence ?? null,
            );
            const unsure =
              ticket.classification !== null &&
              (ticket.classification.confidence ?? 1) < CONFIDENT_ENOUGH;

            return (
              <li key={ticket.id}>
                <Link
                  href={`/tickets/${ticket.id}`}
                  className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.04]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">
                      {previewLine(ticket.subject, ticket.body)}
                    </span>
                    <span className="text-xs text-black/50 dark:text-white/50">
                      {timeAgo(ticket.receivedAt)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-black/60 dark:text-white/60">
                    {ticket.classification ? (
                      <span className="rounded-full border border-black/15 px-2 py-0.5 dark:border-white/20">
                        {CATEGORY_LABELS[ticket.classification.category]}
                        {unsure && confidence !== null
                          ? ` · unsure, ${confidence}%`
                          : ""}
                      </span>
                    ) : (
                      <span className="rounded-full border border-dashed border-black/15 px-2 py-0.5 dark:border-white/20">
                        Not sorted yet
                      </span>
                    )}

                    {ticket.channelType ? (
                      <span>{CHANNEL_LABELS[ticket.channelType]}</span>
                    ) : null}

                    {ticket.customerName || ticket.customerEmail ? (
                      <span>{ticket.customerName ?? ticket.customerEmail}</span>
                    ) : null}

                    {ticket.orderNumber ? <span>{ticket.orderNumber}</span> : null}

                    {ticket.duplicateCount > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                        Also came in{" "}
                        {ticket.duplicateCount === 1
                          ? "somewhere else"
                          : `${ticket.duplicateCount} other times`}
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
