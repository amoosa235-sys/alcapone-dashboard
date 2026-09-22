import assert from "node:assert/strict";
import { test } from "node:test";

import {
  afterCustomerMessage,
  canMove,
  cleanSearch,
  listHref,
  movesFrom,
  parseFilters,
  previewLine,
  queueOrder,
  timeAgo,
  confidencePercent,
} from "./view.ts";

test("an unopened ticket can be started or closed, but not put back where it already is", () => {
  const moves = movesFrom("unopened").map((move) => move.to);
  assert.deepEqual(moves, ["pending", "closed"]);
  assert.equal(canMove("unopened", "unopened"), false);
});

test("a closed ticket reopens as pending rather than as unopened", () => {
  // Reopening something that has been worked on and put back in the unopened
  // pile would read to the next agent as nobody having touched it.
  assert.deepEqual(movesFrom("closed"), [
    { to: "pending", label: "Reopen it" },
  ]);
});

test("every move offered is a move that is allowed", () => {
  for (const from of ["unopened", "pending", "closed"] as const) {
    for (const move of movesFrom(from)) {
      assert.equal(canMove(from, move.to), true);
      assert.notEqual(move.to, from);
    }
  }
});

test("the preview falls back to the body when there is no subject", () => {
  assert.equal(previewLine(null, "  the coat is too small  "), "the coat is too small");
  assert.equal(previewLine("   ", "the coat is too small"), "the coat is too small");
  assert.equal(previewLine(null, null), "No subject");
});

test("the preview collapses the whitespace an email body arrives with", () => {
  assert.equal(
    previewLine(null, "Hi,\n\nThe coat came\tthis morning."),
    "Hi, The coat came this morning.",
  );
});

test("the preview truncates on the limit, counting the ellipsis", () => {
  const line = previewLine(null, "a".repeat(200), 20);
  assert.equal(line.length, 20);
  assert.ok(line.endsWith("…"));
});

test("times read the way a person would say them", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  assert.equal(timeAgo("2026-09-22T11:59:30Z", now), "just now");
  assert.equal(timeAgo("2026-09-22T11:59:00Z", now), "1 minute ago");
  assert.equal(timeAgo("2026-09-22T11:20:00Z", now), "40 minutes ago");
  assert.equal(timeAgo("2026-09-22T09:00:00Z", now), "3 hours ago");
  assert.equal(timeAgo("2026-09-21T09:00:00Z", now), "yesterday");
  assert.equal(timeAgo("2026-09-19T09:00:00Z", now), "3 days ago");
});

test("anything older than a week is given as a date", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  assert.equal(timeAgo("2026-08-30T09:00:00Z", now), "30 Aug 2026");
});

test("a clock skewed into the future does not produce a negative age", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  assert.equal(timeAgo("2026-09-22T12:05:00Z", now), "just now");
});

test("an unparseable timestamp says so rather than showing NaN", () => {
  assert.equal(timeAgo("not a date"), "at an unknown time");
});

test("confidence becomes a percentage, and a missing one stays missing", () => {
  assert.equal(confidencePercent(0.97), 97);
  assert.equal(confidencePercent(0.725), 73);
  assert.equal(confidencePercent(null), null);
});

test("a customer writing back brings an answered or recently closed ticket back to the team", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  assert.deepEqual(afterCustomerMessage({ status: "waiting", closedAt: null }, now), {
    kind: "append",
    status: "pending",
    reopened: false,
  });
  assert.deepEqual(afterCustomerMessage({ status: "unopened", closedAt: null }, now), {
    kind: "append",
    status: "unopened",
    reopened: false,
  });
  assert.deepEqual(
    afterCustomerMessage({ status: "closed", closedAt: "2026-09-20T10:00:00Z" }, now),
    { kind: "append", status: "pending", reopened: true },
  );
});

test("writing back on a thread closed long ago starts a new ticket", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  assert.deepEqual(
    afterCustomerMessage({ status: "closed", closedAt: "2026-07-01T10:00:00Z" }, now),
    { kind: "new-ticket" },
  );
});

test("the piles owing a reply put the longest wait first", () => {
  assert.deepEqual(queueOrder("unopened"), { column: "last_message_at", ascending: true });
  assert.deepEqual(queueOrder("pending"), { column: "last_message_at", ascending: true });
  assert.equal(queueOrder("closed").ascending, false);
  assert.equal(queueOrder("waiting").ascending, false);
});

test("an answered ticket can wait on the customer, and come back from waiting", () => {
  assert.ok(canMove("pending", "waiting"));
  assert.ok(canMove("waiting", "pending"));
  assert.ok(canMove("waiting", "closed"));
  assert.ok(!canMove("unopened", "waiting"));
});

test("search text loses anything that could change the filter it goes into", () => {
  assert.equal(cleanSearch("  bea@example.com "), "bea@example.com");
  assert.equal(cleanSearch("#1001"), "#1001");
  assert.equal(cleanSearch("a,b.or(id.eq.1)"), "a b.or id.eq.1");
  assert.equal(cleanSearch("x"), null);
  assert.equal(cleanSearch("*"), null);
  assert.equal(cleanSearch("O'Brien"), "O'Brien");
});

test("filters from the address bar fall back to defaults when they are nonsense", () => {
  const filters = parseFilters({
    status: "deleted",
    page: "-3",
    category: "spam",
    channel: "not-a-uuid",
    mine: "1",
  });
  assert.equal(filters.status, "unopened");
  assert.equal(filters.page, 1);
  assert.equal(filters.category, null);
  assert.equal(filters.channelId, null);
  assert.equal(filters.mine, true);

  const kept = parseFilters({ status: "waiting", page: "2", q: "bea" });
  assert.equal(kept.status, "waiting");
  assert.equal(kept.page, 2);
  assert.equal(kept.q, "bea");
});

test("a view's address keeps only what differs from the default", () => {
  assert.equal(listHref({ status: "unopened", page: 1 }), "/tickets");
  assert.equal(listHref({ status: "pending", page: 2, mine: true }), "/tickets?status=pending&mine=1&page=2");
  assert.deepEqual(
    parseFilters(Object.fromEntries(new URLSearchParams(listHref({ status: "closed", q: "bea smith" }).split("?")[1]))),
    { ...parseFilters({}), status: "closed", q: "bea smith" },
  );
});
