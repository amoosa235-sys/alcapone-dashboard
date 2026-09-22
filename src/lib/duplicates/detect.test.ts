import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findDuplicates,
  normalizeOrderNumber,
  normalizePhone,
  type DuplicateCandidate,
} from "./detect.ts";

const SHOPIFY: DuplicateCandidate = {
  id: "ticket-shopify",
  channelId: "channel-shopify",
  channelType: "shopify",
  externalThreadId: "order:9001",
  orderNumber: "#1001",
  customerEmail: "bea@example.com",
  customerPhone: "+44 7700 900123",
  category: "exchange",
  receivedAt: "2026-09-22T09:00:00Z",
};

const EMAIL: DuplicateCandidate = {
  id: "ticket-email",
  channelId: "channel-outlook",
  channelType: "outlook",
  externalThreadId: "AAQkAGI2CONV",
  orderNumber: "1001",
  customerEmail: "bea@example.com",
  customerPhone: null,
  category: "exchange",
  receivedAt: "2026-09-22T11:30:00Z",
};

test("order numbers match across the formats each channel uses", () => {
  assert.equal(normalizeOrderNumber("#1001"), "1001");
  assert.equal(normalizeOrderNumber("  1001 "), "1001");
  assert.equal(normalizeOrderNumber("#SO-1001"), "so-1001");
  // Too short to be a real order number, and it would match everything.
  assert.equal(normalizeOrderNumber("#7"), null);
  assert.equal(normalizeOrderNumber(null), null);
});

test("phone numbers match whether or not they carry a country code", () => {
  assert.equal(normalizePhone("+44 7700 900123"), normalizePhone("07700900123"));
  assert.equal(normalizePhone("(07700) 900-123"), "700900123");
  assert.equal(normalizePhone("1234"), null);
});

test("the same order raised on two channels is one issue", () => {
  const [link, ...rest] = findDuplicates(EMAIL, [SHOPIFY, EMAIL]);

  assert.equal(rest.length, 0);
  // The Shopify ticket arrived first, so it is the one to keep.
  assert.equal(link.primaryTicketId, "ticket-shopify");
  assert.equal(link.duplicateTicketId, "ticket-email");
  assert.ok(link.score >= 0.6, `score was ${link.score}`);
  assert.match(link.matchReason, /same order/);
  assert.match(link.matchReason, /arrived on outlook and shopify/);

  // The pair is the same pair whichever side finds it first, so both the
  // ordering and the stored reason have to come out identical.
  const [fromTheOtherSide] = findDuplicates(SHOPIFY, [SHOPIFY, EMAIL]);
  assert.deepEqual(fromTheOtherSide, link);
});

test("two messages in one email thread are a conversation, not a duplicate", () => {
  const reply: DuplicateCandidate = {
    ...EMAIL,
    id: "ticket-email-2",
    receivedAt: "2026-09-22T12:00:00Z",
  };
  const links = findDuplicates(reply, [EMAIL, reply]);
  assert.deepEqual(links, []);
});

test("the same customer with different orders is not a duplicate", () => {
  const other: DuplicateCandidate = {
    ...EMAIL,
    id: "ticket-other-order",
    orderNumber: "2002",
    externalThreadId: "AAQkOTHER",
  };
  const links = findDuplicates(other, [SHOPIFY, other]);
  assert.deepEqual(links, []);
});

test("nothing links on category alone", () => {
  const a: DuplicateCandidate = {
    ...SHOPIFY,
    id: "a",
    orderNumber: null,
    customerEmail: "one@example.com",
    customerPhone: null,
  };
  const b: DuplicateCandidate = {
    ...EMAIL,
    id: "b",
    orderNumber: null,
    customerEmail: "two@example.com",
    customerPhone: null,
  };
  assert.deepEqual(findDuplicates(a, [a, b]), []);
});

test("an issue from months ago is not the same issue", () => {
  const old: DuplicateCandidate = {
    ...SHOPIFY,
    id: "ticket-old",
    receivedAt: "2026-06-01T09:00:00Z",
  };
  assert.deepEqual(findDuplicates(EMAIL, [old, EMAIL]), []);
});

test("a ticket is never a duplicate of itself", () => {
  assert.deepEqual(findDuplicates(SHOPIFY, [SHOPIFY]), []);
});
