"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { getMembership, getUser } from "@/lib/auth";
import {
  channelSpec,
  readChannelForm,
  splitSecrets,
} from "@/lib/channels/specs";
import { classifyOutstanding, syncAllMailboxes } from "@/lib/pipeline/jobs";
import { createAdminClient } from "@/lib/supabase/admin";

export type SaveChannelState = {
  error: string | null;
  saved: string | null;
};

export const EMPTY_SAVE_STATE: SaveChannelState = { error: null, saved: null };

/**
 * Stores the credentials for one account.
 *
 * The channel is written as `pending`, not `connected`: for everything except
 * Shopify there is no integration behind it yet, so nothing will read these
 * values until that step is built. The form says as much, and so does the
 * connected list.
 *
 * Secrets go to channel_secrets, which has RLS on with no policies and its
 * grants revoked, so only the service role can read it back. Nothing secret
 * is ever returned to the browser or written to a log.
 */
export async function saveChannel(
  _previous: SaveChannelState,
  formData: FormData,
): Promise<SaveChannelState> {
  const user = await getUser();
  if (!user) {
    return { error: "Sign in again, your session has expired.", saved: null };
  }

  const membership = await getMembership();
  if (!membership) {
    return { error: "You are not a member of a workspace.", saved: null };
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    return { error: "Only an owner or admin can add an account.", saved: null };
  }

  const type = formData.get("type");
  const spec = typeof type === "string" ? channelSpec(type) : undefined;
  if (!spec) {
    return { error: "That is not an account type I know about.", saved: null };
  }

  if (spec.live) {
    // Shopify connects through OAuth, so its form posts to the install route
    // rather than here. Nothing should reach this, but silently storing a
    // Shopify store as pending would be worse than saying so.
    return {
      error: `${spec.name} connects through its own approval screen. Use the Connect button.`,
      saved: null,
    };
  }

  const read = formData.get.bind(formData);
  const parsed = readChannelForm(spec, (name) => {
    const value = read(name);
    return typeof value === "string" ? value : null;
  });

  if ("missing" in parsed) {
    return {
      error: `Still needed: ${parsed.missing.join(", ")}.`,
      saved: null,
    };
  }

  const { values } = parsed;

  // A verify token is ours to pick when it is left blank; it only has to
  // match what gets configured on the provider's side later.
  if (spec.key === "whatsapp" && !values.verify_token) {
    values.verify_token = randomBytes(16).toString("hex");
  }

  const { secret, config } = splitSecrets(spec, values);
  const identifier = values[spec.identifier];

  const admin = createAdminClient();

  const { data: channel, error: channelError } = await admin
    .from("channels")
    .upsert(
      {
        tenant_id: membership.tenantId,
        type: spec.key,
        status: "pending",
        display_name: identifier,
        external_account_id: identifier,
        config: { ...config, saved_by: user.id },
        last_error: null,
      },
      { onConflict: "tenant_id,type,external_account_id" },
    )
    .select("id")
    .single();

  if (channelError || !channel) {
    console.error("channels: could not save", {
      type: spec.key,
      code: channelError?.code,
      message: channelError?.message,
    });

    if (channelError?.code === "23505") {
      return {
        error:
          "You already have a WhatsApp number on this workspace. v1 allows one.",
        saved: null,
      };
    }

    return { error: "Could not save that. Try again.", saved: null };
  }

  // access_token has its own column; anything else secret goes in extra.
  const { access_token: accessToken, ...rest } = secret;

  const { error: secretError } = await admin.from("channel_secrets").upsert(
    {
      channel_id: channel.id,
      tenant_id: membership.tenantId,
      access_token: accessToken ?? null,
      extra: rest,
    },
    { onConflict: "channel_id" },
  );

  if (secretError) {
    console.error("channels: could not save credentials", {
      type: spec.key,
      code: secretError.code,
      message: secretError.message,
    });
    return {
      error: "The account was saved but its credentials were not. Try again.",
      saved: null,
    };
  }

  revalidatePath("/channels");

  return {
    error: null,
    saved: `${spec.name} saved for ${identifier}. It will start pulling messages in once that integration is built.`,
  };
}

export type RunJobsState = {
  error: string | null;
  summary: string | null;
};

export const EMPTY_RUN_STATE: RunJobsState = { error: null, summary: null };

/**
 * Runs the recurring job now rather than waiting for the hour: check every
 * mailbox, then classify anything still waiting and look for duplicates.
 *
 * The same work runs on a schedule and after every webhook. This is here
 * because waiting an hour to find out whether a mailbox you just connected
 * actually works is no way to set one up.
 */
export async function runJobsNow(
  _previous: RunJobsState,
  _formData: FormData,
): Promise<RunJobsState> {
  const user = await getUser();
  if (!user) {
    return { error: "Sign in again, your session has expired.", summary: null };
  }

  const membership = await getMembership();
  if (!membership) {
    return { error: "You are not a member of a workspace.", summary: null };
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    return { error: "Only an owner or admin can run this.", summary: null };
  }

  const admin = createAdminClient();

  const mailboxes = await syncAllMailboxes(admin, membership.tenantId);
  const processed = await classifyOutstanding(admin, membership.tenantId);

  const failures = [
    ...mailboxes.filter((entry) => entry.error).map((entry) => `${entry.mailbox}: ${entry.error}`),
    ...processed
      .filter((entry) => entry.classificationError)
      .map((entry) => entry.classificationError as string),
  ];

  const newTickets = mailboxes.reduce((total, entry) => total + entry.created, 0);
  const classified = processed.filter((entry) => entry.classified).length;
  const linked = processed.reduce((total, entry) => total + entry.duplicatesLinked, 0);

  const parts = [
    `${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"} checked`,
    `${newTickets} new ticket${newTickets === 1 ? "" : "s"}`,
    `${classified} classified`,
    `${linked} duplicate link${linked === 1 ? "" : "s"}`,
  ];

  revalidatePath("/channels");
  revalidatePath("/");

  return {
    error: failures.length ? failures.join(" · ") : null,
    summary: `${parts.join(", ")}.`,
  };
}
