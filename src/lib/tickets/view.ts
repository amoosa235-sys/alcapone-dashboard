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
  closed: "Closed",
};

export const STATUS_BLURBS: Record<TicketStatus, string> = {
  unopened: "Nobody has picked these up yet.",
  pending: "Being worked on.",
  closed: "Done with.",
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
        { to: "unopened", label: "Put it back" },
      ];
    case "closed":
      return [{ to: "pending", label: "Reopen it" }];
  }
}

export function canMove(from: TicketStatus, to: TicketStatus): boolean {
  return movesFrom(from).some((move) => move.to === to);
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
