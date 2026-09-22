import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getMembership, getUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { exchangeCodeForToken, registerWebhooks } from "@/lib/shopify/admin-api";
import {
  normalizeShopDomain,
  shopifyCredentials,
  webhookUrl,
} from "@/lib/shopify/config";
import type { ConnectErrorCode } from "@/lib/shopify/errors";
import { verifyOAuthCallback } from "@/lib/shopify/hmac";
import {
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  readOAuthState,
} from "@/lib/shopify/state";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Finishes the Shopify install: checks that this is genuinely Shopify calling
 * back on a flow we started, trades the code for a token, and records the
 * store as a channel.
 *
 * Every check below has to pass before anything is written. The order matters
 * less than the fact that none of them is skippable.
 */
export async function GET(request: NextRequest) {
  const back = new URL("/channels", request.url);

  function fail(code: ConnectErrorCode) {
    back.searchParams.set("error", code);
    const response = NextResponse.redirect(back);
    // The nonce is single use whatever the outcome, so a failed attempt
    // cannot be replayed against the cookie it left behind.
    response.cookies.set(OAUTH_STATE_COOKIE, "", {
      ...oauthStateCookieOptions(),
      maxAge: 0,
    });
    return response;
  }

  const user = await getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/channels", request.url));
  }

  const membership = await getMembership();
  if (!membership) {
    return NextResponse.redirect(new URL("/pending", request.url));
  }

  if (membership.role !== "owner" && membership.role !== "admin") {
    return fail("not_admin");
  }

  const credentials = shopifyCredentials();
  if (!credentials) {
    return fail("not_configured");
  }

  const params = request.nextUrl.searchParams;

  const stored = readOAuthState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const state = params.get("state");
  if (!stored || !state || !equal(stored.nonce, state)) {
    return fail("expired");
  }

  const shop = normalizeShopDomain(params.get("shop") ?? "");
  if (!shop || shop !== stored.shop) {
    return fail("shop_mismatch");
  }

  if (!verifyOAuthCallback(params, request.nextUrl.search, credentials.apiSecret)) {
    return fail("bad_signature");
  }

  const code = params.get("code");
  if (!code) {
    return fail("no_code");
  }

  let token;
  try {
    token = await exchangeCodeForToken(shop, code, credentials);
  } catch (error) {
    console.error("shopify: token exchange failed", { shop, error });
    return fail("exchange_failed");
  }

  // Past this point we are writing with the service role, which bypasses RLS,
  // so tenant_id comes from the membership verified above and nowhere else.
  const admin = createAdminClient();

  const { data: channel, error: channelError } = await admin
    .from("channels")
    .upsert(
      {
        tenant_id: membership.tenantId,
        type: "shopify",
        status: "connected",
        display_name: shop.replace(/\.myshopify\.com$/, ""),
        external_account_id: shop,
        config: { scope: token.scope, connected_by: user.id },
        last_error: null,
      },
      { onConflict: "tenant_id,type,external_account_id" },
    )
    .select("id")
    .single();

  if (channelError || !channel) {
    console.error("shopify: could not save the channel", { shop, channelError });
    return fail("save_failed");
  }

  const { error: secretError } = await admin.from("channel_secrets").upsert(
    {
      channel_id: channel.id,
      tenant_id: membership.tenantId,
      access_token: token.access_token,
    },
    { onConflict: "channel_id" },
  );

  if (secretError) {
    console.error("shopify: could not save the access token", { shop, secretError });
    return fail("save_failed");
  }

  const registrations = await registerWebhooks(
    shop,
    token.access_token,
    webhookUrl(request.headers, request.nextUrl.origin),
  );

  const failed = registrations.filter((entry) => entry.error);
  await admin
    .from("channels")
    .update({
      status: failed.length ? "error" : "connected",
      config: {
        scope: token.scope,
        connected_by: user.id,
        webhooks: registrations,
      },
      last_error: failed.length
        ? `Could not subscribe to ${failed.map((entry) => entry.topic).join(", ")}`
        : null,
      last_synced_at: new Date().toISOString(),
    })
    .eq("id", channel.id)
    .eq("tenant_id", membership.tenantId);

  back.searchParams.set("connected", shop);
  const response = NextResponse.redirect(back);
  response.cookies.set(OAUTH_STATE_COOKIE, "", {
    ...oauthStateCookieOptions(),
    maxAge: 0,
  });
  return response;
}
