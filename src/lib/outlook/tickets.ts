/**
 * Turning a Microsoft Graph mail message into a ticket.
 *
 * The work is pulling readable text out of an HTML mail body and finding who
 * sent it. Automatic mail (out-of-office replies, bounces, newsletters) is
 * filtered before this, in automated.ts.
 *
 * The order number is deliberately not guessed here. Classification extracts
 * it from the message, and duplicate detection runs after that, so a regular
 * expression over the subject line would only be a worse answer arriving
 * earlier.
 */

export type GraphEmailAddress = {
  name?: string | null;
  address?: string | null;
};

export type GraphMessage = {
  id?: string;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  from?: { emailAddress?: GraphEmailAddress | null } | null;
  sender?: { emailAddress?: GraphEmailAddress | null } | null;
  replyTo?: { emailAddress?: GraphEmailAddress | null }[] | null;
  internetMessageHeaders?: { name?: string | null; value?: string | null }[] | null;
  receivedDateTime?: string | null;
  createdDateTime?: string | null;
};

export type NormalizedEmail = {
  externalId: string;
  /** The address the message came from, before any Reply-To is applied. */
  fromAddress: string | null;
  externalThreadId: string | null;
  subject: string;
  body: string;
  customerName: string | null;
  customerEmail: string | null;
  receivedAt: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#8217": "’",
  "#8216": "‘",
  "#8220": "“",
  "#8221": "”",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) {
      return ENTITIES[key];
    }
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Enough of an HTML-to-text pass for mail: drop what is not content, keep the
 * line breaks a reader would see, and leave the rest as plain text. It never
 * renders anywhere as HTML, so this is about legibility, not sanitizing.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function address(message: GraphMessage): GraphEmailAddress | null {
  return message.from?.emailAddress ?? message.sender?.emailAddress ?? null;
}

/**
 * Who the customer is. A website contact form sends from its own address and
 * puts the customer in Reply-To, and a reply goes to Reply-To too, so that is
 * the person when it is set.
 */
function customer(message: GraphMessage): GraphEmailAddress | null {
  const replyTo = message.replyTo?.find((entry) => entry.emailAddress?.address)
    ?.emailAddress;
  return replyTo ?? address(message);
}

export function normalizeGraphMessage(
  message: GraphMessage,
): NormalizedEmail | null {
  if (!message.id) {
    return null;
  }

  const from = customer(message);
  const raw = message.body?.content ?? "";
  const isHtml = (message.body?.contentType ?? "").toLowerCase() === "html";
  const body = (isHtml ? htmlToText(raw) : raw.trim()) || (message.bodyPreview ?? "").trim();

  return {
    externalId: message.id,
    fromAddress: address(message)?.address?.trim().toLowerCase() || null,
    externalThreadId: message.conversationId?.trim() || null,
    subject: message.subject?.trim() || "(no subject)",
    body,
    customerName: from?.name?.trim() || null,
    customerEmail: from?.address?.trim().toLowerCase() || null,
    receivedAt:
      message.receivedDateTime ?? message.createdDateTime ?? new Date().toISOString(),
  };
}
