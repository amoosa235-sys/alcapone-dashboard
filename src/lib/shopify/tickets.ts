/**
 * Turning a Shopify webhook into a ticket.
 *
 * Shopify has no customer inbox to read, so what arrives here is order
 * activity. Only the events a support agent would have to do something about
 * become tickets; the rest are acknowledged and dropped. Everything that does
 * becomes a ticket carries the order number and the customer's email and
 * phone, which is what step 7 matches an email or a WhatsApp message against.
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

/**
 * Returns null when the event is real but not something an agent has to act
 * on — an order placed with no message attached, for instance.
 */
export function normalizeShopifyEvent(
  topic: string,
  payload: unknown,
  order: ShopifyOrder | null,
): NormalizedTicket | null {
  const shared = {
    externalThreadId: threadForOrder(order?.id),
    customerName: customerName(order),
    customerEmail: customerEmail(order),
    customerPhone: customerPhone(order),
    orderNumber: orderNumber(order),
  };

  const reference = shared.orderNumber ?? "an order";

  if (topic === "orders/create") {
    const record = payload as ShopifyOrder;
    // An order on its own is not a support ticket. A note on it is the
    // customer having written something, which is.
    if (blank(record.note)) {
      return null;
    }
    return {
      ...shared,
      externalId: `orders/create:${record.id}`,
      subject: `Note on order ${reference}`,
      body: record.note!.trim(),
      receivedAt: record.created_at ?? new Date().toISOString(),
    };
  }

  if (topic === "orders/cancelled") {
    const record = payload as ShopifyOrder;
    const reason = record.cancel_reason?.trim();
    const note = record.note?.trim();
    return {
      ...shared,
      externalId: `orders/cancelled:${record.id}`,
      subject: `Order ${reference} was cancelled`,
      body: [
        reason ? `Reason given: ${reason}.` : "No reason was recorded.",
        note ? `Order note: ${note}` : "",
        describeItems(record.line_items),
      ]
        .filter(Boolean)
        .join("\n\n"),
      receivedAt: record.cancelled_at ?? record.created_at ?? new Date().toISOString(),
    };
  }

  if (topic === "refunds/create") {
    const record = payload as ShopifyRefund;
    const items = record.refund_line_items
      ?.map((line) => ({ ...line.line_item, quantity: line.quantity }))
      .filter(Boolean) as ShopifyLineItem[] | undefined;
    const note = record.note?.trim();
    return {
      ...shared,
      externalId: `refunds/create:${record.id}`,
      subject: `Refund raised on order ${reference}`,
      body: [
        note ? `Refund note: ${note}` : "A refund was raised on this order.",
        describeItems(items),
      ]
        .filter(Boolean)
        .join("\n\n"),
      receivedAt: record.created_at ?? new Date().toISOString(),
    };
  }

  return null;
}
