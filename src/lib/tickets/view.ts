import type { Enums } from "@/types/database";

/**
 * How a ticket is described on screen.
 *
 * Kept away from the pages, and free of imports beyond the types, so the
 * wording and the allowed moves can be tested without rendering anything.
 */

export type TicketStatus = Enums<"ticket_status">;
export type TicketCategory = Enums<"ticket_category">;

export const STATUS_LABELS: Record<TicketStatus, string> = {
  unopened: "Unopened",
  pending: "Pending",
  waiting: "Waiting on customer",
  closed: "Closed",
};

export const STATUS_BLURBS: Record<TicketStatus, string> = {
  unopened: "Nobody has picked these up yet. Longest waiting first.",
  pending: "Being worked on, or the customer has written back. Longest waiting first.",
  waiting: "Answered. These come back to Pending when the customer replies.",
  closed: "Done with. Most recently closed first.",
};

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  enquiry: "Enquiry",
  return: "Return",
  exchange: "Exchange",
  general_complaint: "Complaint",
};

export const CHANNEL_LABELS: Record<Enums<"channel_type">, string> = {
  shopify: "Shopify",
  outlook: "Email",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
};

export type StatusMove = {
  to: TicketStatus;
  /** What the button says, verb first, so it reads as the thing it does. */
  label: string;
};

/**
 * Where a ticket can go from where it is.
 *
 * Deliberately not every combination: the moves offered are the ones an agent
 * actually makes, and the first in each list is the ordinary next step.
 */
export function movesFrom(status: TicketStatus): StatusMove[] {
  switch (status) {
    case "unopened":
      return [
        { to: "pending", label: "Start working on it" },
        { to: "closed", label: "Close it" },
      ];
    case "pending":
      return [
        { to: "closed", label: "Close it" },
        { to: "waiting", label: "Waiting on the customer" },
        { to: "unopened", label: "Put it back" },
      ];
    case "waiting":
      return [
        { to: "closed", label: "Close it" },
        { to: "pending", label: "Back to working on it" },
      ];
    case "closed":
      return [{ to: "pending", label: "Reopen it" }];
  }
}

export function canMove(from: TicketStatus, to: TicketStatus): boolean {
  return movesFrom(from).some((move) => move.to === to);
}

/**
 * A closed conversation the customer writes back on within this many days is
 * reopened. After that, a reply on an old thread is a new problem and gets a
 * ticket of its own.
 */
export const REOPEN_WINDOW_DAYS = 30;

export type CustomerMessageOutcome =
  | { kind: "append"; status: TicketStatus; reopened: boolean }
  | { kind: "new-ticket" };

/**
 * What a customer writing again does to the ticket their conversation is on.
 *
 * The ball comes back to the team: an answered or closed ticket goes back to
 * pending, so it sits in the pile of things needing a reply. An unopened or
 * pending ticket is already there and stays put.
 */
export function afterCustomerMessage(
  ticket: { status: TicketStatus; closedAt: string | null },
  now: Date = new Date(),
): CustomerMessageOutcome {
  switch (ticket.status) {
    case "unopened":
    case "pending":
      return { kind: "append", status: ticket.status, reopened: false };
    case "waiting":
      return { kind: "append", status: "pending", reopened: false };
    case "closed": {
      const closed = ticket.closedAt ? Date.parse(ticket.closedAt) : Number.NaN;
      const age = (now.getTime() - closed) / 86_400_000;
      if (Number.isFinite(age) && age > REOPEN_WINDOW_DAYS) {
        return { kind: "new-ticket" };
      }
      return { kind: "append", status: "pending", reopened: true };
    }
  }
}

/**
 * How each pile is ordered. The two piles that need a reply put whoever has
 * waited longest at the top; a pile of answered or finished work puts the
 * most recent first, because that is what somebody goes looking for.
 */
export function queueOrder(status: TicketStatus): {
  column: "last_message_at" | "closed_at" | "updated_at";
  ascending: boolean;
} {
  switch (status) {
    case "unopened":
    case "pending":
      return { column: "last_message_at", ascending: true };
    case "waiting":
      return { column: "updated_at", ascending: false };
    case "closed":
      return { column: "closed_at", ascending: false };
  }
}

/** How many tickets a page of the queue shows. */
export const PAGE_SIZE = 50;

/**
 * What an agent typed into the search box, reduced to something safe to put
 * in a filter: letters, digits and the punctuation that appears in names,
 * emails, phone numbers and order numbers. PostgREST filter syntax uses
 * commas, brackets, quotes and asterisks, so none of those survive.
 */
export function cleanSearch(input: string | null | undefined): string | null {
  const cleaned = (input ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}@.+\-#' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned.length >= 2 ? cleaned : null;
}

/** What the queue is narrowed to, as read from the address bar. */
export type TicketFilters = {
  status: TicketStatus;
  page: number;
  q: string | null;
  category: TicketCategory | null;
  channelId: string | null;
  mine: boolean;
  /** Tickets Claude gave up on, whichever pile they are in. */
  sorting: "failed" | null;
  /** Tickets with a reply whose send never confirmed. */
  stuck: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
}

/**
 * The address bar is typed by anybody, so anything unrecognised falls back
 * to the default rather than reaching a query.
 */
export function parseFilters(params: Record<string, string | string[] | undefined>): TicketFilters {
  const status = one(params.status);
  const category = one(params.category);
  const channel = one(params.channel);
  const page = Number.parseInt(one(params.page) ?? "1", 10);
  return {
    status: status && status in STATUS_LABELS ? (status as TicketStatus) : "unopened",
    page: Number.isFinite(page) && page >= 1 && page <= 1000 ? page : 1,
    q: cleanSearch(one(params.q)),
    category: category && category in CATEGORY_LABELS ? (category as TicketCategory) : null,
    channelId: channel && UUID.test(channel) ? channel : null,
    mine: one(params.mine) === "1",
    sorting: one(params.sorting) === "failed" ? "failed" : null,
    stuck: one(params.stuck) === "1",
  };
}

/** The address for a view of the queue, keeping only what differs from the default. */
export function listHref(filters: Partial<TicketFilters>): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "unopened") params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.channelId) params.set("channel", filters.channelId);
  if (filters.mine) params.set("mine", "1");
  if (filters.sorting) params.set("sorting", filters.sorting);
  if (filters.stuck) params.set("stuck", "1");
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `/tickets?${query}` : "/tickets";
}

/**
 * A one-line stand-in for a ticket with no subject, taken from the message
 * itself. Whitespace in an email body is not meaningful, so it collapses.
 */
export function previewLine(
  subject: string | null,
  body: string | null,
  limit = 80,
): string {
  const source = (subject ?? "").trim() || (body ?? "").trim();
  if (!source) {
    return "No subject";
  }

  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * How long ago something arrived, in the words a person would use. Anything
 * older than a week is a date instead, because "23 days ago" is not useful.
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "at an unknown time";
  }

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);

  if (seconds < 0) {
    return "just now";
  }
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Confidence as a percentage, or null when the model did not give one. */
export function confidencePercent(confidence: number | null): number | null {
  if (confidence === null || Number.isNaN(confidence)) {
    return null;
  }
  return Math.round(confidence * 100);
}

/**
 * Whether a classification is sure enough to lead with. Below this the
 * category is still shown, but as a guess rather than a fact, because the
 * classifier is told to go under 0.5 when a message is too vague to sort.
 */
export const CONFIDENT_ENOUGH = 0.5;
