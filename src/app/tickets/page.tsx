import Link from "next/link";

import { requireMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { countTicketsByStatus, listMembers, listTickets } from "@/lib/tickets/queries";
import {
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  CONFIDENT_ENOUGH,
  PAGE_SIZE,
  STATUS_BLURBS,
  STATUS_LABELS,
  confidencePercent,
  listHref,
  parseFilters,
  previewLine,
  timeAgo,
} from "@/lib/tickets/view";
import { TICKET_STATUSES } from "@/types/database";

import { bulkClose } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets" };

const DONE_NOTES: Record<string, string> = {
  closed: "Closed.",
  sent: "Sent. That was the last one in this pile.",
  waiting: "Handed to the customer. That was the last one in this pile.",
};

/**
 * The inbox: everything that has come in, in piles, the longest-waiting
 * first where a reply is owed.
 *
 * Everything that narrows the list lives in the address bar, so a view can be
 * bookmarked, shared, and survives a reload.
 */
export default async function TicketsPage({ searchParams }: PageProps<"/tickets">) {
  const { user } = await requireMembership();

  const params = await searchParams;
  const filters = parseFilters(params);
  const supabase = await createClient();

  const [counts, { items: tickets, total }, members, { data: channels }] = await Promise.all([
    countTicketsByStatus(),
    listTickets(filters, user.id),
    listMembers(),
    supabase.from("channels").select("id, type, display_name").order("display_name"),
  ]);

  const memberEmail = new Map(members.map((member) => [member.userId, member.email]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const special = filters.q
    ? `Everything matching “${filters.q}”, in every pile.`
    : filters.sorting === "failed"
      ? "Tickets Claude could not sort. Open one to retry, or sort it yourself."
      : filters.stuck
        ? "Replies that were sent but never confirmed. Open one to settle it."
        : null;
  const done = typeof params.done === "string" ? params.done : null;
  const doneCount = typeof params.count === "string" ? Number.parseInt(params.count, 10) : null;
  const canClose = !filters.q && !filters.sorting && !filters.stuck && filters.status !== "closed";
  const here = listHref(filters);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs underline">
          Back to the dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {special ?? STATUS_BLURBS[filters.status]}
        </p>
      </header>

      {done ? (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
          {done === "closed" && doneCount !== null && Number.isFinite(doneCount)
            ? `Closed ${doneCount} ${doneCount === 1 ? "ticket" : "tickets"}.`
            : (DONE_NOTES[done] ?? "Done.")}
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-2">
        {TICKET_STATUSES.map((value) => {
          const active = !special && value === filters.status;
          return (
            <Link
              key={value}
              href={listHref({ ...filters, status: value, page: 1, q: null, sorting: null, stuck: false })}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
                  : "rounded-md border border-black/10 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              }
            >
              {STATUS_LABELS[value]}
              <span className="ml-2 tabular-nums opacity-60">{counts[value]}</span>
            </Link>
          );
        })}
      </nav>

      <form method="get" action="/tickets" className="flex flex-wrap items-end gap-2 text-sm">
        <input type="hidden" name="status" value={filters.status} />
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-xs text-black/60 dark:text-white/60">
            Search name, email, phone, order or subject
          </span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            className="rounded-md border border-black/15 bg-transparent px-3 py-1.5 dark:border-white/20"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-black/60 dark:text-white/60">Kind</span>
          <select
            name="category"
            defaultValue={filters.category ?? ""}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20"
          >
            <option value="">Any</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-black/60 dark:text-white/60">Channel</span>
          <select
            name="channel"
            defaultValue={filters.channelId ?? ""}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20"
          >
            <option value="">Any</option>
            {(channels ?? []).map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.display_name} ({CHANNEL_LABELS[channel.type]})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 py-1.5">
          <input type="checkbox" name="mine" value="1" defaultChecked={filters.mine} />
          Mine only
        </label>
        <button className="rounded-md border border-black/15 px-3 py-1.5 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5">
          Show
        </button>
        {filters.q || filters.category || filters.channelId || filters.mine || special ? (
          <Link href={listHref({ status: filters.status })} className="py-1.5 text-xs underline">
            Clear
          </Link>
        ) : null}
      </form>

      {tickets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm text-black/60 dark:border-white/20 dark:text-white/60">
          {special || filters.category || filters.channelId || filters.mine ? (
            "Nothing matches."
          ) : (
            <>
              Nothing {STATUS_LABELS[filters.status].toLowerCase()}.{" "}
              <Link href="/channels" className="underline">
                Connect a channel
              </Link>{" "}
              and tickets arrive here.
            </>
          )}
        </p>
      ) : (
        <form action={bulkClose} className="flex flex-col gap-3">
          <input type="hidden" name="back" value={here} />
          <ul className="flex flex-col gap-2">
            {tickets.map((ticket) => {
              const confidence = confidencePercent(ticket.classification?.confidence ?? null);
              const unsure =
                ticket.classification !== null &&
                ticket.classification.source === "claude" &&
                (ticket.classification.confidence ?? 1) < CONFIDENT_ENOUGH;
              const assignee = ticket.assignedTo
                ? ticket.assignedTo === user.id
                  ? "You"
                  : (memberEmail.get(ticket.assignedTo) ?? "Someone")
                : null;

              return (
                <li key={ticket.id} className="flex items-start gap-3">
                  {canClose ? (
                    <input
                      type="checkbox"
                      name="ticketIds"
                      value={ticket.id}
                      aria-label="Tick to close"
                      className="mt-5"
                    />
                  ) : null}
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="flex flex-1 flex-col gap-2 rounded-lg border border-black/10 p-4 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.04]"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="font-medium">{previewLine(ticket.subject, ticket.body)}</span>
                      <span className="text-xs text-black/50 dark:text-white/50">
                        {special ? `${STATUS_LABELS[ticket.status]} · ` : ""}
                        {timeAgo(ticket.lastMessageAt)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-black/60 dark:text-white/60">
                      {ticket.classification ? (
                        <span className="rounded-full border border-black/15 px-2 py-0.5 dark:border-white/20">
                          {CATEGORY_LABELS[ticket.classification.category]}
                          {unsure && confidence !== null ? ` · unsure, ${confidence}%` : ""}
                        </span>
                      ) : ticket.classificationStatus === "failed" ? (
                        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-300">
                          Claude could not sort this
                        </span>
                      ) : (
                        <span className="rounded-full border border-dashed border-black/15 px-2 py-0.5 dark:border-white/20">
                          Not sorted yet
                        </span>
                      )}

                      {ticket.channelType ? <span>{CHANNEL_LABELS[ticket.channelType]}</span> : null}

                      {ticket.customerName || ticket.customerEmail ? (
                        <span>{ticket.customerName ?? ticket.customerEmail}</span>
                      ) : null}

                      {ticket.orderNumber ? <span>{ticket.orderNumber}</span> : null}

                      {assignee ? <span>With {assignee}</span> : null}

                      {ticket.duplicateCount > 0 ? (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                          Maybe the same as{" "}
                          {ticket.duplicateCount === 1 ? "another ticket" : `${ticket.duplicateCount} others`}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>

          {canClose ? (
            <div>
              <button className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5">
                Close the ticked tickets
              </button>
            </div>
          ) : null}
        </form>
      )}

      {pages > 1 ? (
        <nav className="flex items-center justify-between text-sm">
          {filters.page > 1 ? (
            <Link href={listHref({ ...filters, page: filters.page - 1 })} className="underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-black/60 dark:text-white/60">
            Page {filters.page} of {pages}, {total} tickets
          </span>
          {filters.page < pages ? (
            <Link href={listHref({ ...filters, page: filters.page + 1 })} className="underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
