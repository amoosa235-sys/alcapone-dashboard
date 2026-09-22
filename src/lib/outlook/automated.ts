/**
 * Telling a person writing in apart from a machine.
 *
 * A support inbox receives out-of-office replies, bounces, newsletters,
 * delivery receipts and notifications from every service the business uses.
 * None of those is a customer asking for something, and each one would
 * otherwise become a ticket and a paid Claude call. Mail systems mark most of
 * them in their headers, so this reads the headers rather than guessing from
 * the words.
 */

export type MessageHeader = { name?: string | null; value?: string | null };

/** Senders that are always a mail system talking, never a customer. */
const DELIVERY_SYSTEMS = /^(mailer-daemon|postmaster|mail-daemon|bounces?)([+.-][^@]*)?@/i;

/**
 * Senders that are usually a notification. Website contact forms also send
 * from addresses like these, with the customer in Reply-To, so these only
 * count when there is no Reply-To pointing at somebody else.
 */
const NOTIFICATION_SENDERS = /^(no-?reply|do-?not-?reply|donotreply|notifications?)([+.-][^@]*)?@/i;

export type AutomatedVerdict = { automated: false } | { automated: true; reason: string };

export function detectAutomated(message: {
  headers: MessageHeader[] | null | undefined;
  fromAddress: string | null | undefined;
  replyToAddress?: string | null;
  mailbox: string | null | undefined;
  subject?: string | null;
}): AutomatedVerdict {
  const from = (message.fromAddress ?? "").trim().toLowerCase();
  const mailbox = (message.mailbox ?? "").trim().toLowerCase();

  if (from && mailbox && from === mailbox) {
    return { automated: true, reason: "sent from this mailbox itself" };
  }

  if (from && DELIVERY_SYSTEMS.test(from)) {
    return { automated: true, reason: `sent by ${from.split("@")[0]}` };
  }

  const replyTo = (message.replyToAddress ?? "").trim().toLowerCase();
  const answersSomeoneElse = Boolean(replyTo) && replyTo !== from;
  if (from && !answersSomeoneElse && NOTIFICATION_SENDERS.test(from)) {
    return { automated: true, reason: `sent by ${from.split("@")[0]}` };
  }

  const headers = new Map<string, string>();
  for (const header of message.headers ?? []) {
    const name = header.name?.trim().toLowerCase();
    if (name) {
      headers.set(name, (header.value ?? "").trim().toLowerCase());
    }
  }

  // RFC 3834: anything other than "no" means a machine sent it.
  const autoSubmitted = headers.get("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") {
    return { automated: true, reason: `auto-submitted (${autoSubmitted})` };
  }

  const precedence = headers.get("precedence");
  if (precedence && /^(bulk|junk|list|auto_reply)$/.test(precedence)) {
    return { automated: true, reason: `precedence ${precedence}` };
  }

  // Exchange and Outlook mark their own automatic replies this way.
  if (headers.has("x-autoreply") || headers.has("x-autorespond")) {
    return { automated: true, reason: "automatic reply" };
  }
  const suppress = headers.get("x-auto-response-suppress");
  if (suppress && /\b(all|oof|autoreply)\b/.test(suppress) && headers.has("x-ms-exchange-generated-message-source")) {
    return { automated: true, reason: "automatic reply" };
  }

  // Mailing lists and newsletters.
  if (headers.has("list-id") || headers.has("list-unsubscribe")) {
    return { automated: true, reason: "mailing list or newsletter" };
  }

  // Delivery reports carry this content type even when the sender is not
  // one of the usual system names.
  const contentType = headers.get("content-type") ?? "";
  if (/multipart\/report/.test(contentType)) {
    return { automated: true, reason: "delivery report" };
  }

  const subject = (message.subject ?? "").trim().toLowerCase();
  if (/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)\b/.test(subject)) {
    return { automated: true, reason: "automatic reply" };
  }
  if (/^(undeliverable|delivery status notification|mail delivery (failed|subsystem))\b/.test(subject)) {
    return { automated: true, reason: "delivery report" };
  }

  return { automated: false };
}
