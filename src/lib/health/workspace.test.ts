import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceWarnings, type WorkspaceHealthInput } from "./workspace.ts";

const NOW = new Date("2026-09-23T10:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const HEALTHY: WorkspaceHealthInput = {
  channels: [
    {
      type: "outlook",
      status: "connected",
      display_name: "support@shop.example",
      last_error: null,
      last_synced_at: ago(5),
      config: { last_checked_at: ago(5), expires_on: "2027-06-01" },
    },
  ],
  lastJobRunAt: ago(4),
  failedClassifications: 0,
  stuckSends: 0,
};

test("a healthy workspace has nothing to say", () => {
  assert.deepEqual(workspaceWarnings(HEALTHY, NOW), []);
});

test("a quiet mailbox is not a stale one: checking counts, not new mail", () => {
  const quiet = {
    ...HEALTHY,
    channels: [{ ...HEALTHY.channels[0], last_synced_at: ago(60 * 24 * 3) }],
  };
  assert.deepEqual(workspaceWarnings(quiet, NOW), []);
});

test("a mailbox nobody has checked for hours is flagged", () => {
  const stale = {
    ...HEALTHY,
    channels: [{ ...HEALTHY.channels[0], config: { last_checked_at: ago(60 * 5) } }],
  };
  const [warning] = workspaceWarnings(stale, NOW);
  assert.match(warning.text, /not been checked for 5 hours/);
});

test("a client secret about to run out is flagged, and one already gone is critical", () => {
  const soon = {
    ...HEALTHY,
    channels: [{ ...HEALTHY.channels[0], config: { last_checked_at: ago(5), expires_on: "2026-10-03" } }],
  };
  const [warning] = workspaceWarnings(soon, NOW);
  assert.equal(warning.level, "warning");
  assert.match(warning.text, /expires in 10 days/);

  const gone = {
    ...HEALTHY,
    channels: [{ ...HEALTHY.channels[0], config: { last_checked_at: ago(5), expires_on: "2026-09-01" } }],
  };
  assert.equal(workspaceWarnings(gone, NOW)[0].level, "critical");
});

test("a channel in error, a silent scheduler, stuck sends and failed sorting all surface", () => {
  const broken: WorkspaceHealthInput = {
    channels: [{ ...HEALTHY.channels[0], status: "error", last_error: "Microsoft refused the sign-in" }],
    lastJobRunAt: ago(90),
    failedClassifications: 3,
    stuckSends: 1,
  };
  const texts = workspaceWarnings(broken, NOW).map((warning) => warning.text).join("\n");
  assert.match(texts, /has stopped: Microsoft refused the sign-in/);
  assert.match(texts, /last ran/);
  assert.match(texts, /could not sort 3 tickets/);
  assert.match(texts, /1 reply may or may not have reached the customer/);
});

test("with nothing connected, a scheduler that has never run is not news", () => {
  assert.deepEqual(
    workspaceWarnings({ channels: [], lastJobRunAt: null, failedClassifications: 0, stuckSends: 0 }, NOW),
    [],
  );
});
