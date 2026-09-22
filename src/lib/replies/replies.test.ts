import assert from "node:assert/strict";
import { test } from "node:test";

import { SEND_TIMEOUT_MS, sendOutcomeUnknown } from "./outcome.ts";
import { fillTemplate } from "./templates.ts";

test("a saved reply is filled in from the ticket", () => {
  const filled = fillTemplate("Hi {first_name}, about order {order} ({ item }). {workspace}", {
    name: "Bea Smith",
    order: "#1001",
    item: "Blue mug",
    workspace: "Acme",
  });
  assert.equal(filled, "Hi Bea, about order #1001 (Blue mug). Acme");
});

test("a gap the ticket cannot fill stays visible instead of going out blank", () => {
  const filled = fillTemplate("Hi {first_name}, order {order}", {
    name: null,
    order: "  ",
    item: null,
    workspace: null,
  });
  assert.equal(filled, "Hi [first name], order [order]");
});

test("curly brackets that are not placeholders are left alone", () => {
  assert.equal(
    fillTemplate("Use code {SAVE10} or {unknown}", { name: null, order: null, item: null, workspace: null }),
    "Use code {SAVE10} or {unknown}",
  );
});

test("a send is only in doubt once it has had time to finish", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  const started = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  assert.equal(
    sendOutcomeUnknown({ status: "sending", sending_started_at: started(10_000), updated_at: started(10_000) }, now),
    false,
  );
  assert.equal(
    sendOutcomeUnknown(
      { status: "sending", sending_started_at: started(SEND_TIMEOUT_MS + 1000), updated_at: started(0) },
      now,
    ),
    true,
  );
  // A row claimed before the column existed falls back to when it last changed.
  assert.equal(
    sendOutcomeUnknown({ status: "sending", sending_started_at: null, updated_at: started(SEND_TIMEOUT_MS * 3) }, now),
    true,
  );
  assert.equal(
    sendOutcomeUnknown({ status: "draft", sending_started_at: null, updated_at: started(SEND_TIMEOUT_MS * 3) }, now),
    false,
  );
});
