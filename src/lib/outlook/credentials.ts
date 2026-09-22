import { fetchGraphToken } from "./graph";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * A Graph token for one mailbox channel, from its app registration. The
 * tenant and client ids are in the channel's config; the client secret is in
 * channel_secrets, which only the service role can read.
 */
export async function outlookToken(
  admin: Admin,
  channel: { id: string; external_account_id: string | null; config: unknown },
): Promise<{ token: string; mailbox: string } | { error: string }> {
  const mailbox = channel.external_account_id ?? "";
  const config = (channel.config ?? {}) as Record<string, unknown>;
  const tenantId = typeof config.tenant_id === "string" ? config.tenant_id : null;
  const clientId = typeof config.client_id === "string" ? config.client_id : null;

  const { data: secret } = await admin
    .from("channel_secrets")
    .select("extra")
    .eq("channel_id", channel.id)
    .maybeSingle();

  const extra = (secret?.extra ?? {}) as Record<string, unknown>;
  const clientSecret =
    typeof extra.client_secret === "string" ? extra.client_secret : null;

  if (!mailbox || !tenantId || !clientId || !clientSecret) {
    return {
      error:
        "This mailbox is missing part of its app registration. Re-enter it on the Channels page.",
    };
  }

  try {
    const token = await fetchGraphToken({ tenantId, clientId, clientSecret });
    return { token, mailbox };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Microsoft refused the sign-in.",
    };
  }
}
