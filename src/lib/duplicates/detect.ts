/**
 * Spotting the same issue arriving twice.
 *
 * The case this exists for is one customer raising one problem on two
 * channels -- an email about the order they just had refunded, a WhatsApp
 * message about the return they already started. Handling that twice is the
 * thing the product is meant to prevent.
 *
 * Matching runs on what the channel knew plus what classification extracted,
 * so it has to run after classification, not before.
 */

export type DuplicateCandidate = {
  id: string;
  channelId: string | null;
  channelType: string | null;
  externalThreadId: string | null;
  orderNumber: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  category: string | null;
  receivedAt: string;
};

export type DuplicateLink = {
  primaryTicketId: string;
  duplicateTicketId: string;
  score: number;
  matchReason: string;
};

/** Two tickets more than this far apart are not the same incident. */
export const MATCH_WINDOW_DAYS = 14;

/** Below this, a pair is a coincidence rather than a duplicate. */
export const MATCH_THRESHOLD = 0.6;

/**
 * What the matcher needs to know about the workspace rather than the pair.
 *
 * Shopify numbers orders per store, and every store starts at #1001, so an
 * order number only identifies an order once you know which store it is
 * from. With one store connected that is never in doubt.
 */
export type MatchContext = {
  shopifyStores: number;
};

/** `#1001`, `1001` and ` #1001 ` are one order. */
export function normalizeOrderNumber(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "");
  // A one or two character "order number" matches far too much to trust.
  return cleaned.length >= 3 ? cleaned : null;
}

export function normalizeEmail(value: string | null): string | null {
  const cleaned = value?.trim().toLowerCase();
  return cleaned || null;
}

/**
 * Phone numbers arrive as +44 7700 900123 from one channel and 07700900123
 * from another. Comparing the last nine digits treats those as one person
 * without pretending to parse dialling codes.
 */
export function normalizePhone(value: string | null): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 9 ? digits.slice(-9) : null;
}

function daysApart(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(left - right) / 86_400_000;
}

type Signal = { weight: number; reason: string };

/**
 * Whether two order numbers can be the same order at all.
 *
 * Two Shopify tickets from different stores never share an order, whatever
 * their numbers say. A number read out of an email could belong to any
 * store, so with more than one store it is only trusted when something else
 * about the customer agrees.
 */
function orderScope(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  context: MatchContext,
): "same-store" | "different-stores" | "unknown-store" {
  const aShop = a.channelType === "shopify";
  const bShop = b.channelType === "shopify";
  if (aShop && bShop) {
    return a.channelId === b.channelId ? "same-store" : "different-stores";
  }
  if (context.shopifyStores <= 1) {
    return "same-store";
  }
  return "unknown-store";
}

function signals(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  context: MatchContext,
): Signal[] {
  const found: Signal[] = [];

  const orderA = normalizeOrderNumber(a.orderNumber);
  const scope = orderScope(a, b, context);
  if (
    orderA &&
    orderA === normalizeOrderNumber(b.orderNumber) &&
    scope !== "different-stores"
  ) {
    // The normalized form, not the raw one: Shopify writes #1001 and an
    // email says 1001, and the reason is stored against the pair, so it has
    // to read the same whichever side found the match.
    found.push({ weight: 0.6, reason: `same order ${orderA}` });
  }

  const emailA = normalizeEmail(a.customerEmail);
  if (emailA && emailA === normalizeEmail(b.customerEmail)) {
    found.push({ weight: 0.25, reason: "same email address" });
  }

  const phoneA = normalizePhone(a.customerPhone);
  if (phoneA && phoneA === normalizePhone(b.customerPhone)) {
    found.push({ weight: 0.2, reason: "same phone number" });
  }

  if (a.category && a.category === b.category) {
    found.push({ weight: 0.15, reason: `both ${a.category.replace(/_/g, " ")}` });
  }

  if (a.channelType && b.channelType && a.channelType !== b.channelType) {
    // Sorted so the stored reason reads the same whichever of the two
    // tickets happened to trigger the match.
    const [first, second] = [a.channelType, b.channelType].sort();
    found.push({ weight: 0.1, reason: `arrived on ${first} and ${second}` });
  }

  return found;
}

/**
 * Compares one ticket against everything else open for the tenant. Returns
 * the pairs worth showing an agent, strongest first, with the older ticket as
 * the primary one.
 */
export function findDuplicates(
  subject: DuplicateCandidate,
  candidates: DuplicateCandidate[],
  context: MatchContext = { shopifyStores: 1 },
): DuplicateLink[] {
  const links: DuplicateLink[] = [];

  for (const other of candidates) {
    if (other.id === subject.id) {
      continue;
    }

    // Two messages in one email thread, or two events on one Shopify order,
    // are the same conversation. That is threading, not duplication.
    if (
      subject.externalThreadId &&
      subject.channelId === other.channelId &&
      subject.externalThreadId === other.externalThreadId
    ) {
      continue;
    }

    if (daysApart(subject.receivedAt, other.receivedAt) > MATCH_WINDOW_DAYS) {
      continue;
    }

    // Two different orders are two different problems, however much else
    // about the customer is the same. A repeat customer writing about each
    // of their orders is not writing twice about one.
    const orderA = normalizeOrderNumber(subject.orderNumber);
    const orderB = normalizeOrderNumber(other.orderNumber);
    if (orderA && orderB && orderA !== orderB) {
      continue;
    }

    const matched = signals(subject, other, context);
    // Matching on category alone would link every complaint to every other.
    const byOrder = matched.some((signal) => signal.reason.startsWith("same order"));
    const byPerson = matched.some((signal) =>
      /same email|same phone/.test(signal.reason),
    );
    if (!byOrder && !byPerson) {
      continue;
    }

    // An order number that could belong to any of several stores is only
    // believed when the customer matches too.
    if (byOrder && !byPerson && orderScope(subject, other, context) === "unknown-store") {
      continue;
    }

    const score = Math.min(
      1,
      matched.reduce((total, signal) => total + signal.weight, 0),
    );

    if (score < MATCH_THRESHOLD) {
      continue;
    }

    const subjectIsOlder =
      Date.parse(subject.receivedAt) <= Date.parse(other.receivedAt);

    links.push({
      primaryTicketId: subjectIsOlder ? subject.id : other.id,
      duplicateTicketId: subjectIsOlder ? other.id : subject.id,
      score: Number(score.toFixed(3)),
      matchReason: matched.map((signal) => signal.reason).join(", "),
    });
  }

  return links.sort((a, b) => b.score - a.score);
}
