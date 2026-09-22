import type { Enums } from "@/types/database";

/**
 * What each kind of account needs before it can be saved.
 *
 * One list drives three things: the fields the form renders, what the server
 * action validates, and where each value is stored. They cannot drift apart,
 * which is the point of keeping them here rather than in the form.
 *
 * `live` is whether the integration behind the channel actually runs yet.
 * Credentials for one that does not are still accepted and stored, because
 * gathering them is work worth doing once; the channel just sits at `pending`
 * until its integration is built, and every form for one says so.
 */

export type ChannelField = {
  name: string;
  label: string;
  placeholder?: string;
  /** Rendered as a password field and never sent back to the browser. */
  secret?: boolean;
  help?: string;
  optional?: boolean;
};

export type ChannelSpec = {
  key: Enums<"channel_type">;
  name: string;
  /** Which of the three menus on the channels page this sits under. */
  menu: "shopify" | "email" | "social";
  live: boolean;
  /** The field whose value names the account in the connected list. */
  identifier: string;
  fields: ChannelField[];
  /** Where in the provider's console these values are found. */
  where: string;
};

export const CHANNEL_SPECS: ChannelSpec[] = [
  {
    key: "shopify",
    name: "Shopify store",
    menu: "shopify",
    live: true,
    identifier: "shop",
    where: "Your store's address, the one ending in myshopify.com.",
    fields: [
      {
        name: "shop",
        label: "Store address",
        placeholder: "acme-supplies.myshopify.com",
        help: "Approving on Shopify is what connects it. Nothing is stored until you do.",
      },
    ],
  },
  {
    key: "outlook",
    name: "Microsoft 365 (Outlook)",
    menu: "email",
    live: false,
    identifier: "mailbox",
    where:
      "Azure portal, Microsoft Entra ID, App registrations, then your app. The secret is under Certificates & secrets.",
    fields: [
      {
        name: "mailbox",
        label: "Mailbox address",
        placeholder: "support@yourcompany.com",
        help: "The inbox whose messages become tickets.",
      },
      {
        name: "tenant_id",
        label: "Directory (tenant) ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
      },
      {
        name: "client_id",
        label: "Application (client) ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
      },
      { name: "client_secret", label: "Client secret value", secret: true },
    ],
  },
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    menu: "social",
    live: false,
    identifier: "phone_number_id",
    where: "Meta for Developers, your app, WhatsApp, API setup.",
    fields: [
      {
        name: "phone_number_id",
        label: "Phone number ID",
        help: "The numeric id, not the phone number itself.",
      },
      { name: "waba_id", label: "WhatsApp Business Account ID" },
      { name: "access_token", label: "Permanent access token", secret: true },
      {
        name: "verify_token",
        label: "Webhook verify token",
        secret: true,
        optional: true,
        help: "Any string you choose. Leave it blank and one is generated for you.",
      },
    ],
  },
  {
    key: "instagram",
    name: "Instagram",
    menu: "social",
    live: false,
    identifier: "account_id",
    where: "Meta for Developers, your app, Instagram.",
    fields: [
      { name: "account_id", label: "Instagram professional account ID" },
      { name: "page_id", label: "Linked Facebook Page ID" },
      { name: "access_token", label: "Access token", secret: true },
    ],
  },
  {
    key: "facebook",
    name: "Facebook",
    menu: "social",
    live: false,
    identifier: "page_id",
    where: "Meta for Developers, your app, Messenger, Settings.",
    fields: [
      { name: "page_id", label: "Facebook Page ID" },
      { name: "access_token", label: "Page access token", secret: true },
    ],
  },
];

export function channelSpec(key: string): ChannelSpec | undefined {
  return CHANNEL_SPECS.find((spec) => spec.key === key);
}

export function specsForMenu(menu: ChannelSpec["menu"]): ChannelSpec[] {
  return CHANNEL_SPECS.filter((spec) => spec.menu === menu);
}

/**
 * Splits a submitted form into the values a spec asks for, or lists the
 * required fields that came back empty.
 */
export function readChannelForm(
  spec: ChannelSpec,
  read: (name: string) => string | null,
): { values: Record<string, string> } | { missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of spec.fields) {
    const value = (read(field.name) ?? "").trim();
    if (!value) {
      if (!field.optional) {
        missing.push(field.label);
      }
      continue;
    }
    values[field.name] = value;
  }

  return missing.length ? { missing } : { values };
}

/** Which submitted values are secret, and so belong in channel_secrets. */
export function splitSecrets(
  spec: ChannelSpec,
  values: Record<string, string>,
): { secret: Record<string, string>; config: Record<string, string> } {
  const secret: Record<string, string> = {};
  const config: Record<string, string> = {};

  for (const field of spec.fields) {
    const value = values[field.name];
    if (value === undefined) {
      continue;
    }
    (field.secret ? secret : config)[field.name] = value;
  }

  return { secret, config };
}
