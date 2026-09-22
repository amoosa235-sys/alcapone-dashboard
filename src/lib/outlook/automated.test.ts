import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAutomated } from "./automated.ts";

const MAILBOX = "support@shop.example";

function check(overrides: Partial<Parameters<typeof detectAutomated>[0]>) {
  return detectAutomated({
    headers: [],
    fromAddress: "bea@example.com",
    mailbox: MAILBOX,
    subject: "Where is my parcel?",
    ...overrides,
  });
}

test("an ordinary customer email is a person", () => {
  assert.deepEqual(check({}), { automated: false });
  assert.deepEqual(check({ headers: [{ name: "Auto-Submitted", value: "no" }] }), { automated: false });
});

test("out-of-office replies are caught by header and by subject", () => {
  assert.equal(check({ headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }).automated, true);
  assert.equal(check({ headers: [{ name: "X-Autoreply", value: "yes" }] }).automated, true);
  assert.equal(check({ subject: "Automatic reply: Where is my parcel?" }).automated, true);
  assert.equal(check({ subject: "Out of Office: back Monday" }).automated, true);
});

test("bounces and delivery reports are caught", () => {
  assert.equal(check({ fromAddress: "MAILER-DAEMON@mx.example" }).automated, true);
  assert.equal(check({ fromAddress: "postmaster@example.com" }).automated, true);
  assert.equal(check({ subject: "Undeliverable: Your order" }).automated, true);
  assert.equal(
    check({ headers: [{ name: "Content-Type", value: "multipart/report; report-type=delivery-status" }] }).automated,
    true,
  );
});

test("newsletters and mailing lists are caught", () => {
  assert.equal(check({ headers: [{ name: "List-Unsubscribe", value: "<mailto:x@y>" }] }).automated, true);
  assert.equal(check({ headers: [{ name: "Precedence", value: "bulk" }] }).automated, true);
});

test("mail the mailbox sent itself is never a ticket", () => {
  assert.equal(check({ fromAddress: "Support@Shop.Example" }).automated, true);
});

test("a no-reply notification is dropped, but a contact form with a Reply-To is a person", () => {
  assert.equal(check({ fromAddress: "no-reply@shopify.com" }).automated, true);
  assert.deepEqual(
    check({ fromAddress: "noreply@forms.example", replyToAddress: "bea@example.com" }),
    { automated: false },
  );
});
