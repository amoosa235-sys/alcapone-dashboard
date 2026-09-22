/**
 * Turning a Shopify webhook into a ticket.
 *
 * Shopify has no customer inbox to read, so what arrives here is order
 * activity. A note the customer left on an order becomes a ticket.
 * Cancellations and refunds become order history. Both carry the order number
 * and the customer's email and phone, which is what an email or a WhatsApp
 * message is matched against.
 */

export type ShopifyLineItem = {
  id?: number;
  name?: string;
  title?: string;
  variant_title?: string | null;
  sku?: string | null;
  quantity?: number;
};

export type ShopifyOrder = {
  id?: number;
  name?: string;
  order_number?: number;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  created_at?: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  line_items?: ShopifyLineItem[];
  shipping_address?: { name?: string | null; phone?: string | null } | null;
  billing_address?: { name?: string | null; phone?: string | null } | null;
  refunds?: ShopifyRefund[];
};

export type ShopifyRefund = {
  id?: number;
  order_id?: number;
  note?: string | null;
  created_at?: string;
  refund_line_items?: { quantity?: number; line_item?: ShopifyLineItem }[];
};

export type NormalizedTicket = {
  externalId: string;
  externalThreadId: string | null;
  subject: string;
  body: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  orderNumber: string | null;
  receivedAt: string;
};

function blank(value: string | null | undefined): boolean {
  return !value || value.trim() === "";
}

function customerName(order: ShopifyOrder | null): string | null {
  const first = order?.customer?.first_name?.trim() ?? "";
  const last = order?.customer?.last_name?.trim() ?? "";
  const joined = [first, last].filter(Boolean).join(" ");
  if (joined) {
    return joined;
  }
  return order?.shipping_address?.name?.trim() || order?.billing_address?.name?.trim() || null;
}

function customerEmail(order: ShopifyOrder | null): string | null {
  return order?.customer?.email?.trim() || order?.email?.trim() || null;
}

function customerPhone(order: ShopifyOrder | null): string | null {
  return (
    order?.customer?.phone?.trim() ||
    order?.phone?.trim() ||
    order?.shipping_address?.phone?.trim() ||
    null
  );
}

/** "#1001" as Shopify shows it, falling back to the numeric order number. */
function orderNumber(order: ShopifyOrder | null): string | null {
  if (order?.name?.trim()) {
    return order.name.trim();
  }
  return order?.order_number != null ? `#${order.order_number}` : null;
}

function describeItems(items: ShopifyLineItem[] | undefined): string {
  if (!items?.length) {
    return "";
  }
  return items
    .map((item) => {
      const name = item.name ?? item.title ?? "Item";
      const variant = item.variant_title ? ` (${item.variant_title})` : "";
      const sku = item.sku ? ` [${item.sku}]` : "";
      return `- ${item.quantity ?? 1} x ${name}${variant}${sku}`;
    })
    .join("\n");
}

/**
 * Groups every event about the same order onto one thread, so a note, a
 * cancellation and a refund on order 1001 are visibly the same conversation.
 */
function threadForOrder(orderId: number | undefined): string | null {
  return orderId != null ? `order:${orderId}` : null;
}

export type NormalizedOrderEvent = {
  externalId: string;
  kind: "cancelled" | "refunded";
  orderNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  summary: string;
  occurredAt: string;
};

/**
 * What a Shopify event becomes.
 *
 * Only an order note is a customer writing in, so only a note becomes a
 * ticket. Cancellations and refunds are the store's own staff acting, and a
 * ticket for each would put the team's own work back in front of them as
 * something to answer. They are kept as order history instead, shown beside
 * the customer's tickets.
 */
export type ShopifyOutcome =
  | { kind: "ticket"; ticket: NormalizedTicket }
  | { kind: "event"; event: NormalizedOrderEvent };

function noteTicket(order: ShopifyOrder): NormalizedTicket | null {
  if (blank(order.note)) {
    return null;
  }
  const number = orderNumber(order);
  return {
    externalThreadId: threadForOrder(order.id),
    customerName: customerName(order),
    customerEmail: customerEmail(order),
    customerPhone: customerPhone(order),
    orderNumber: number,
    externalId: `orders/create:${order.id}`,
    subject: `Note on order ${number ?? "an order"}`,
    body: order.note!.trim(),
    receivedAt: order.created_at ?? new Date().toISOString(),
  };
}

function cancellationEvent(order: ShopifyOrder): NormalizedOrderEvent {
  const reason = order.cancel_reason?.trim();
  const items = describeItems(order.line_items);
  return {
    externalId: `orders/cancelled:${order.id}`,
    kind: "cancelled",
    orderNumber: orderNumber(order),
    customerName: customerName(order),
    customerEmail: customerEmail(order),
    customerPhone: customerPhone(order),
    summary: [
      reason ? `Cancelled. Reason given: ${reason}.` : "Cancelled. No reason was recorded.",
      items,
    ]
      .filter(Boolean)
      .join("\n"),
    occurredAt: order.cancelled_at ?? order.created_at ?? new Date().toISOString(),
  };
}

function refundEvent(refund: ShopifyRefund, order: ShopifyOrder | null): NormalizedOrderEvent {
  const items = refund.refund_line_items
    ?.map((line) => ({ ...line.line_item, quantity: line.quantity }))
    .filter(Boolean) as ShopifyLineItem[] | undefined;
  const note = refund.note?.trim();
  return {
    externalId: `refunds/create:${refund.id}`,
    kind: "refunded",
    orderNumber: orderNumber(order),
    customerName: customerName(order),
    customerEmail: customerEmail(order),
    customerPhone: customerPhone(order),
    summary: [
      note ? `Refunded. Note: ${note}` : "Refunded.",
      describeItems(items),
    ]
      .filter(Boolean)
      .join("\n"),
    occurredAt: refund.created_at ?? new Date().toISOString(),
  };
}

/**
 * Returns null when the event is real but not something to keep: an order
 * placed with no message attached, for instance.
 */
export function normalizeShopifyEvent(
  topic: string,
  payload: unknown,
  order: ShopifyOrder | null,
): ShopifyOutcome | null {
  if (topic === "orders/create") {
    const ticket = noteTicket(payload as ShopifyOrder);
    return ticket ? { kind: "ticket", ticket } : null;
  }

  if (topic === "orders/cancelled") {
    return { kind: "event", event: cancellationEvent(payload as ShopifyOrder) };
  }

  if (topic === "refunds/create") {
    return { kind: "event", event: refundEvent(payload as ShopifyRefund, order) };
  }

  return null;
}

/**
 * Everything worth keeping about an order fetched from the Admin API, for
 * catching up on webhooks that never arrived. The external ids are the same
 * ones the webhooks produce, so anything already received is skipped.
 */
export function outcomesFromOrder(order: ShopifyOrder): ShopifyOutcome[] {
  const outcomes: ShopifyOutcome[] = [];
  const ticket = noteTicket(order);
  if (ticket) {
    outcomes.push({ kind: "ticket", ticket });
  }
  if (order.cancelled_at) {
    outcomes.push({ kind: "event", event: cancellationEvent(order) });
  }
  for (const refund of order.refunds ?? []) {
    outcomes.push({ kind: "event", event: refundEvent(refund, order) });
  }
  return outcomes;
}
