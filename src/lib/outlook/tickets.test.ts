import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText, normalizeGraphMessage } from "./tickets.ts";

test("an HTML mail body becomes readable text", () => {
  const html = `
    <html><head><style>p { color: red }</style></head>
    <body><p>Hi there,</p>
    <p>My order <b>#1001</b> arrived with the wrong size.<br>Can I swap it?</p>
    <ul><li>Wool coat &mdash; M</li><li>Scarf</li></ul>
    <script>tracking()</script>
    <p>Thanks &amp; regards,<br>Bea</p></body></html>`;

  const text = htmlToText(html);

  assert.match(text, /Hi there,/);
  assert.match(text, /order #1001 arrived with the wrong size\./);
  assert.match(text, /Can I swap it\?/);
  assert.match(text, /- Wool coat/);
  assert.match(text, /Thanks & regards,/);
  // Style and script contents are not part of what the customer wrote.
  assert.doesNotMatch(text, /color: red/);
  assert.doesNotMatch(text, /tracking\(\)/);
  assert.doesNotMatch(text, /</);
});

test("entities decode, including numeric ones", () => {
  assert.equal(htmlToText("<p>it&#39;s &quot;fine&quot; &#8212; really</p>"), 'it\'s "fine" — really');
  assert.equal(htmlToText("<p>a&nbsp;&nbsp;b</p>"), "a b");
});

test("a Graph message becomes a ticket", () => {
  const ticket = normalizeGraphMessage({
    id: "AAMkAGI2THE-ID",
    conversationId: "AAQkAGI2CONV",
    subject: "  Order #1001 arrived damaged  ",
    body: { contentType: "html", content: "<p>The coat has a tear.</p>" },
    from: { emailAddress: { name: "  Bea Khan ", address: "  Bea@Example.COM " } },
    receivedDateTime: "2026-09-22T09:15:00Z",
  });

  assert.ok(ticket);
  assert.equal(ticket.externalId, "AAMkAGI2THE-ID");
  assert.equal(ticket.externalThreadId, "AAQkAGI2CONV");
  assert.equal(ticket.subject, "Order #1001 arrived damaged");
  assert.equal(ticket.body, "The coat has a tear.");
  assert.equal(ticket.customerName, "Bea Khan");
  // Addresses are lower-cased so that matching against another channel works.
  assert.equal(ticket.customerEmail, "bea@example.com");
  assert.equal(ticket.receivedAt, "2026-09-22T09:15:00Z");
});

test("a plain text message is left alone, and a missing subject is named", () => {
  const ticket = normalizeGraphMessage({
    id: "plain",
    body: { contentType: "text", content: "  where is my order?  " },
    sender: { emailAddress: { address: "someone@example.com" } },
    createdDateTime: "2026-09-22T10:00:00Z",
  });

  assert.ok(ticket);
  assert.equal(ticket.body, "where is my order?");
  assert.equal(ticket.subject, "(no subject)");
  assert.equal(ticket.externalThreadId, null);
  assert.equal(ticket.customerName, null);
  assert.equal(ticket.receivedAt, "2026-09-22T10:00:00Z");
});

test("a message with no id is not a ticket", () => {
  assert.equal(normalizeGraphMessage({ subject: "orphan" }), null);
});

test("an empty body falls back to the preview Graph already made", () => {
  const ticket = normalizeGraphMessage({
    id: "preview-only",
    bodyPreview: "Short version of the message",
    body: { contentType: "html", content: "" },
  });
  assert.equal(ticket?.body, "Short version of the message");
});
