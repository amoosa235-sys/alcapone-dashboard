import Link from "next/link";

import { requireMembership } from "@/lib/auth";
import { isShopifyConfigured, normalizeShopDomain } from "@/lib/shopify/config";
import { channelSpec } from "@/lib/channels/specs";
import { connectErrorMessage } from "@/lib/shopify/errors";
import { createClient } from "@/lib/supabase/server";
import type { Enums } from "@/types/database";

import { AddAccountMenus } from "./add-account-menus";

export const dynamic = "force-dynamic";
export const metadata = { title: "Channels" };

/**
 * Where a store, mailbox or social account gets connected.
 *
 * Every account type is listed whether or not it can be used yet, and one
 * that cannot says why. A menu that hides its own options reads as a page
 * with nothing on it.
 */
export default async function ChannelsPage({
  searchParams,
}: PageProps<"/channels">) {
  const { membership } = await requireMembership();
  const params = await searchParams;
  const channels = await listChannels();

  const canManage = membership.role === "owner" || membership.role === "admin";
  const shopifyReady = isShopifyConfigured();

  // Both of these came in on a query string, so neither is rendered as it
  // arrived: an error is looked up by code, and a shop name has to be a real
  // myshopify.com domain to be shown at all.
  const error = connectErrorMessage(
    typeof params.error === "string" ? params.error : undefined,
  );
  const connected =
    typeof params.connected === "string"
      ? normalizeShopDomain(params.connected)
      : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-xs underline">
          Back to the dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Every account tickets arrive from.
        </p>
      </header>

      {connected ? (
        <p className="rounded-md border border-green-600/30 bg-green-600/5 px-4 py-3 text-sm">
          {connected} is connected. Order notes, cancellations and refunds will
          arrive as tickets from now on.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-600/30 bg-red-600/5 px-4 py-3 text-sm text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}

      <AddAccountMenus shopifyReady={shopifyReady} canManage={canManage} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Connected</h2>
        {channels.length === 0 ? (
          <p className="text-sm text-black/60 dark:text-white/60">
            Nothing yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {channels.map((channel) => (
              <li
                key={channel.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    {channel.display_name}
                  </span>
                  <span className="text-xs text-black/50 dark:text-white/50">
                    {channelSpec(channel.type)?.name ?? channel.type}
                  </span>
                </div>
                <span className="shrink-0 text-right text-xs text-black/50 dark:text-white/50">
                  {channel.last_error ? (
                    <span className="text-red-600">{channel.last_error}</span>
                  ) : (
                    describeStatus(channel.status)
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * Anything not `connected` is credentials sitting and waiting, so the list
 * says that rather than showing a bare status word that reads as working.
 */
function describeStatus(status: Enums<"channel_status">): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "pending":
      return "Saved, not connected yet";
    case "disabled":
      return "Disabled";
    case "error":
      return "Needs attention";
  }
}

/** RLS scopes this to the caller's tenant, so there is no filter here. */
async function listChannels() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("channels")
    .select("id, type, status, display_name, last_error")
    .order("created_at", { ascending: true });
  return data ?? [];
}
