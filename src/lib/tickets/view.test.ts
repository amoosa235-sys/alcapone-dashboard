import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canMove,
  movesFrom,
  previewLine,
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
