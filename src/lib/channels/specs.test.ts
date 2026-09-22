import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHANNEL_SPECS,
  channelSpec,
  readChannelForm,
  specsForMenu,
  splitSecrets,
} from "./specs.ts";

test("every spec's identifier is one of its own fields, and never a secret", () => {
  for (const spec of CHANNEL_SPECS) {
    const field = spec.fields.find((f) => f.name === spec.identifier);
    assert.ok(field, `${spec.key} names an identifier it does not ask for`);
    // The identifier becomes display_name and external_account_id, both of
    // which are readable by anyone in the workspace. A secret there would
    // walk straight out of channel_secrets.
    assert.notEqual(field.secret, true, `${spec.key} identifies itself by a secret`);
    assert.notEqual(field.optional, true, `${spec.key} has an optional identifier`);
  }
});

test("every spec has a unique key and sits under one of the three menus", () => {
  const keys = CHANNEL_SPECS.map((spec) => spec.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    specsForMenu("shopify").length + specsForMenu("email").length + specsForMenu("social").length,
    CHANNEL_SPECS.length,
  );
  assert.equal(channelSpec("nonsense"), undefined);
  assert.equal(channelSpec("whatsapp")?.name, "WhatsApp Business");
});

test("only Shopify claims to have an integration behind it", () => {
  const live = CHANNEL_SPECS.filter((spec) => spec.live).map((spec) => spec.key);
  assert.deepEqual(live, ["shopify"]);
});

test("a form is read back field by field, and missing ones are named", () => {
  const spec = channelSpec("outlook")!;
  const submitted: Record<string, string> = {
    mailbox: "  support@example.com  ",
    tenant_id: "t-1",
    client_id: "c-1",
    client_secret: "s-1",
  };

  const parsed = readChannelForm(spec, (name) => submitted[name] ?? null);
  assert.ok("values" in parsed);
  // Whitespace around a pasted value is the norm, not an error.
  assert.equal(parsed.values.mailbox, "support@example.com");

  const partial = readChannelForm(spec, (name) =>
    name === "mailbox" ? "support@example.com" : null,
  );
  assert.ok("missing" in partial);
  assert.deepEqual(partial.missing, [
    "Directory (tenant) ID",
    "Application (client) ID",
    "Client secret value",
  ]);
});

test("an optional field left blank does not block the save", () => {
  const spec = channelSpec("whatsapp")!;
  const submitted: Record<string, string> = {
    phone_number_id: "123",
    waba_id: "456",
    access_token: "tok",
    verify_token: "",
  };

  const parsed = readChannelForm(spec, (name) => submitted[name] ?? null);
  assert.ok("values" in parsed);
  assert.equal(parsed.values.verify_token, undefined);
});

test("secrets are separated from the values that go in the clear", () => {
  const spec = channelSpec("outlook")!;
  const { secret, config } = splitSecrets(spec, {
    mailbox: "support@example.com",
    tenant_id: "t-1",
    client_id: "c-1",
    client_secret: "s-1",
  });

  assert.deepEqual(config, {
    mailbox: "support@example.com",
    tenant_id: "t-1",
    client_id: "c-1",
  });
  assert.deepEqual(secret, { client_secret: "s-1" });
});

test("every token or secret field is marked secret", () => {
  for (const spec of CHANNEL_SPECS) {
    for (const field of spec.fields) {
      if (/token|secret|password/i.test(field.name)) {
        assert.equal(
          field.secret,
          true,
          `${spec.key}.${field.name} looks like a credential but is not marked secret`,
        );
      }
    }
  }
});
