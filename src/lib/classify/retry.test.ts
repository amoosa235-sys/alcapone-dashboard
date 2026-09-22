import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CLASSIFICATION_ATTEMPTS, afterClassification } from "./retry.ts";

const NOW = new Date("2026-09-23T10:00:00Z");

test("a success clears any earlier failure", () => {
  assert.deepEqual(afterClassification(2, { ok: true }, NOW), {
    classification_status: "done",
    classification_attempts: 3,
    classification_error: null,
    classification_retry_at: null,
  });
});

test("a failure worth retrying waits longer each time", () => {
  const first = afterClassification(0, { ok: false, error: "rate limited", retryable: true }, NOW);
  assert.equal(first.classification_status, "pending");
  assert.equal(first.classification_retry_at, "2026-09-23T10:02:00.000Z");

  const third = afterClassification(2, { ok: false, error: "rate limited", retryable: true }, NOW);
  assert.equal(third.classification_retry_at, "2026-09-23T10:08:00.000Z");
});

test("it gives up after the last attempt, and at once on a hopeless failure", () => {
  const last = afterClassification(MAX_CLASSIFICATION_ATTEMPTS - 1, {
    ok: false,
    error: "overloaded",
    retryable: true,
  });
  assert.equal(last.classification_status, "failed");
  assert.equal(last.classification_retry_at, null);

  const hopeless = afterClassification(0, { ok: false, error: "refused", retryable: false });
  assert.equal(hopeless.classification_status, "failed");
  assert.equal(hopeless.classification_error, "refused");
});
